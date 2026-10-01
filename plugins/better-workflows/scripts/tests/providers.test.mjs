import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildContract, canonicalJson, loadDefaults, sha256 } from "../lib/core.mjs";
import { autoPolicyDefinition } from "../lib/auto-policy-v1.mjs";
import {
  buildEvaluatorInferenceInput,
  evaluatorToolPolicy,
  validateEvaluatorRegistryProbeRequest,
  validateEvaluatorResponseStream
} from "../host-trust.mjs";
import {
  binaryIdentity,
  discoverProviderModels,
  doctorAgy,
  parseModelCatalog,
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
    template: "auto",
    templateDefinition: autoPolicyDefinition("code-change-v1"),
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

test("spawnCapture records an early provider exit without surfacing stdin EPIPE", async () => {
  const result = await spawnCapture(
    process.execPath,
    ["-e", "process.stdin.destroy(); process.stdout.write('done'); process.exit(0)"],
    {
      input: "x".repeat(2 * 1024 * 1024),
      timeoutMs: 5_000,
      maxOutputBytes: 1024
    }
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "done");
  assert.equal(result.timedOut, false);
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
  for (const mutate of [
    value => { value.schemaVersion = 5; },
    value => { delete value.responsePolicy; },
    value => { delete value.responseEnvelopePolicy; },
    value => { value.responseEnvelopePolicy = "allow-http-200-without-body-validation"; },
    value => { value.schemaVersion = 6; delete value.responseEnvelopePolicy; },
    value => { delete value.clientBootstrapPolicy; },
    value => { value.maxAllowedToolCalls = 1; },
    value => { value.disabledFeatures = value.disabledFeatures.filter(feature => feature !== "shell_tool"); },
    value => { value.engineFeaturePolicy.unified_exec = "unrestricted"; }
  ]) {
    const mutated = structuredClone(policy); mutate(mutated);
    assert.throws(() => validateTrustedEvaluatorToolPolicy(mutated, sha256(canonicalJson(mutated))), /exact tool-free capability policy/);
  }
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
    forwardedBodyDigest: "1".repeat(64),
    responseProof: validateEvaluatorResponseStream(Buffer.from(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`))
  };
  const unsigned = {
    schemaVersion: 4,
    transport: "openai-responses-http-canonical-gate-v4",
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
  const legacyUnsigned = { ...unsigned, schemaVersion: 3, transport: "openai-responses-http-canonical-gate-v3" };
  const legacy = { ...legacyUnsigned, digest: sha256(canonicalJson(legacyUnsigned)) };
  assert.throws(() => validateTrustedEvaluatorRegistryProof(legacy, legacy.digest, "gpt-5.6-terra"), /identity or digest is invalid/);
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
  for (const mutate of [
    request => { delete request.responseProof; },
    request => { request.responseProof.toolCalls = 1; },
    request => { request.responseProof.policy = "unchecked"; },
    request => { request.responseProof.eventCount = 0; },
    request => { request.responseProof.eventCount = 1.5; },
    request => { request.responseProof.digest = "bad"; },
    request => { request.responseProof.forwardedDigest = "bad"; },
    request => { request.responseProof.extra = true; }
  ]) {
    const modified = structuredClone(unsigned); mutate(modified.requests[0]);
    const invalid = { ...modified, digest: sha256(canonicalJson(modified)) };
    assert.throws(() => validateTrustedEvaluatorRegistryProof(invalid, invalid.digest, "gpt-5.6-terra"), /invalid or tool-capable request|bounded zero-tool response/);
  }
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

test("Agy adapter does not promote arbitrary model text to reported identity", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-provider-model-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = await executable(
    directory,
    "agy-fake",
    "printf '%s\\n' '{\"verdict\":\"PASS\",\"summary\":\"review text names another model: gpt-spoofed\",\"model\":\"gpt-spoofed\",\"findings\":[]}'"
  );
  const requestedModel = "requested-model-v5";
  const result = await runAgyCritic({
    model: requestedModel,
    prompt: "Sanitized design with untrusted provider text",
    contract: agyContract(),
    config: await loadDefaults(),
    command: fake,
    timeoutMs: 5_000
  });

  assert.equal(result.review.model, "gpt-spoofed");
  assert.match(result.review.summary, /gpt-spoofed/);
  assert.equal(result.metadata.requestedModel, requestedModel);
  assert.equal(result.metadata.reportedModel, null);
  assert.equal(result.metadata.modelAssurance, "requested-not-attested");
  assert.equal(result.metadata.trustAttested, undefined);
});

test("Codex critic keeps arbitrary review model text out of reported identity", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-codex-model-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fakeCodex = await executable(
    directory,
    "codex",
    "printf '%s\\n' '{\"verdict\":\"PASS\",\"summary\":\"review text names another model: codex-spoofed\",\"model\":\"codex-spoofed\",\"findings\":[]}'"
  );
  const quotedFakeCodex = fakeCodex.replaceAll("'", "'\\''");
  await executable(
    directory,
    "which",
    `case "$1" in codex) printf '%s\\n' '${quotedFakeCodex}' ;; *) exit 1 ;; esac`
  );
  const moduleUrl = new URL("../lib/providers.mjs", import.meta.url).href;
  const childScript = [
    `const { runCodexCritic } = await import(${JSON.stringify(moduleUrl)});`,
    "const result = await runCodexCritic({ model: 'requested-codex-model', effort: 'high', prompt: 'safe fixture', timeoutMs: 5000 });",
    "process.stdout.write(JSON.stringify({ review: result.review, metadata: result.metadata }));"
  ].join("\n");
  const child = await spawnCapture(process.execPath, ["--input-type=module", "-e", childScript], {
    cwd: directory,
    env: { PATH: directory },
    timeoutMs: 15_000
  });
  assert.equal(child.code, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.review.model, "codex-spoofed");
  assert.equal(result.metadata.requestedModel, "requested-codex-model");
  assert.equal(result.metadata.reportedModel, null);
  assert.equal(result.metadata.modelAssurance, "requested-not-attested");
  assert.equal(result.metadata.binary.path, await realpath(fakeCodex));
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

test("model catalogs accept current provider output without hard-coded model names", async () => {
  assert.deepEqual(
    parseModelCatalog([
      "Fetching available models...",
      "gemini-9.9-flash-high    Gemini 9.9 Flash (High)",
      "gpt-oss-999b-medium\tGPT-OSS 999B (Medium)"
    ].join("\n"), "agy-lines-v1"),
    [
      { model: "gemini-9.9-flash-high", displayModel: "Gemini 9.9 Flash (High)" },
      { model: "gpt-oss-999b-medium", displayModel: "GPT-OSS 999B (Medium)" }
    ]
  );
  assert.deepEqual(
    parseModelCatalog(JSON.stringify({ models: [{ model: "sonnet-9", display_name: "Sonnet 9", reasoningEfforts: ["max"] }] }), "json-v1"),
    [{ model: "sonnet-9", displayModel: "Sonnet 9", reasoningEfforts: ["max"] }]
  );
});

test("model catalog limits apply equally to environment and command inputs", async () => {
  const raw = JSON.stringify({ models: Array.from({ length: 257 }, (_, index) => `model-${index}`) });
  assert.throws(() => parseModelCatalog(raw), /256-model limit/);
  assert.throws(() => parseModelCatalog(" ".repeat(256 * 1024 + 1)), /256 KiB/);
  const result = await discoverProviderModels({
    provider: { modelDiscovery: { type: "environment", variable: "SBW_TEST_MODELS", format: "json-v1" } },
    env: { SBW_TEST_MODELS: raw }
  });
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.models, []);
});

test("Agy effort rejection cannot silently retry a probe or critic", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-agy-no-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const countPath = path.join(directory, "calls");
  const quotedCountPath = countPath.replaceAll("'", "'\\''");
  const fake = await executable(directory, "agy-fake", `printf 'call\\n' >> '${quotedCountPath}'\nprintf '%s\\n' '--effort is not supported' >&2\nexit 2`);
  const doctor = await doctorAgy({ model: "current-model", command: fake, timeoutMs: 5000 });
  assert.equal(doctor.ok, false);
  assert.equal(doctor.effortTransport, "native");
  assert.equal(await readFile(countPath, "utf8"), "call\n");
  await assert.rejects(runAgyCritic({
    model: "current-model", prompt: "Sanitized local fixture", contract: agyContract(),
    config: await loadDefaults(), command: fake, timeoutMs: 5000
  }), /Agy critic failed with exit 2/);
  assert.equal(await readFile(countPath, "utf8"), "call\ncall\n");
});

test("dynamic roster refreshes when the provider catalog changes while its CLI stays the same", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-dynamic-roster-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalogFile = path.join(directory, "models.txt");
  await writeFile(catalogFile, "gemini-9.9-flash-high    Gemini 9.9 Flash (High)\n");
  const quotedCatalogFile = catalogFile.replaceAll("'", "'\\''");
  const fake = await executable(
    directory,
    "provider",
    `case "$1" in models) cat '${quotedCatalogFile}' ;; *) printf 'SBW_TEST_MARKER\\n' ;; esac`
  );
  const config = {
    schemaVersion: 3,
    terminology: {
      modelBrands: ["Gemini"],
      transportCommand: fake,
      transportModelBrands: ["Gemini"],
      transportIsModelBrand: false
    },
    probeMarker: "SBW_TEST_MARKER",
    probeTimeoutSeconds: 5,
    rosterCacheHours: 24,
    maxParticipants: 24,
    reasoningEffort: {
      default: "auto",
      allowed: ["medium", "high"],
      modeDefaults: { deep: "high" }
    },
    providers: [{
      id: "gemini",
      command: fake,
      probe: "text",
      external: false,
      supportedBrands: ["Gemini"],
      role: "researcher",
      capabilityRank: 1,
      reasoningEfforts: ["medium", "high"],
      effortTransport: "prompt-guidance",
      modelDiscovery: {
        type: "command",
        args: ["models"],
        format: "agy-lines-v1",
        defaultBrand: "Gemini"
      }
    }],
    arbiterPriority: [{ provider: "gemini", brand: "Gemini" }]
  };
  const stateRoot = path.join(directory, "state");
  const options = {
    config,
    stateRoot,
    allowExternalProviders: true,
    sanitized: true,
    mode: "deep",
    reasoningEffort: "high",
    timeoutSeconds: 5
  };
  const first = await probeDeliberationRoster(options);
  assert.deepEqual(first.activeParticipants.map((item) => item.model), ["gemini-9.9-flash-high"]);
  assert.equal(first.modelCatalog[0].status, "discovered");
  assert.equal(first.activeParticipants[0].availabilityBasis.at(-1), "semantic-probe");

  await writeFile(catalogFile, "gemini-10.0-flash-high    Gemini 10.0 Flash (High)\n");
  const second = await probeDeliberationRoster(options);
  assert.deepEqual(second.activeParticipants.map((item) => item.model), ["gemini-10.0-flash-high"]);
  assert.equal(second.cache.status, "stored");
  assert.notEqual(second.catalogDigest, first.catalogDigest);

  const third = await probeDeliberationRoster(options);
  assert.equal(third.cache.status, "hit");
  assert.deepEqual(third.activeParticipants.map((item) => item.model), ["gemini-10.0-flash-high"]);
});

test("deliberation probes keep requested models separate from arbitrary provider text", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-deliberation-model-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const textProvider = await executable(
    directory,
    "text-provider",
    `case " $* " in *" --effort "*) printf 'AGY_DOCTOR_OK\\n' ;; *) printf '%s\\n' '{"marker":"SBW_TEST_MARKER","model":"spoofed-provider-model"}' ;; esac`
  );
  const agyProvider = await executable(
    directory,
    "agy-provider",
    `case " $* " in *" --effort "*) printf 'AGY_DOCTOR_OK\\n' ;; *) printf '%s\\n' '{"marker":"SBW_TEST_MARKER","model":"spoofed-provider-model"}' ;; esac`
  );
  const config = {
    schemaVersion: 3,
    terminology: {
      modelBrands: ["Fake"],
      transportCommand: textProvider,
      transportModelBrands: ["Fake"],
      transportIsModelBrand: false
    },
    reasoningEffort: { default: "high", allowed: ["medium", "high"], modeDefaults: { deep: "high" } },
    probeMarker: "SBW_TEST_MARKER",
    probeTimeoutSeconds: 5,
    rosterCacheHours: 24,
    maxParticipants: 4,
    providers: [
      {
        id: "fake-text",
        command: textProvider,
        probe: "text",
        external: false,
        supportedBrands: ["Fake"],
        models: [{ model: "text-requested-model", brand: "Fake", role: "text", capabilityRank: 1, reasoningEfforts: ["high"] }]
      },
      {
        id: "fake-agy",
        command: agyProvider,
        probe: "agy",
        external: false,
        supportedBrands: ["Fake"],
        effortTransport: "native",
        models: [{ model: "agy-requested-model", brand: "Fake", role: "agy", capabilityRank: 2, reasoningEfforts: ["high"] }]
      }
    ],
    arbiterPriority: []
  };
  const roster = await probeDeliberationRoster({
    config,
    stateRoot: path.join(directory, "state"),
    reasoningEffort: "high"
  });

  const textParticipant = roster.activeParticipants.find(item => item.provider === "fake-text");
  const agyParticipant = roster.activeParticipants.find(item => item.provider === "fake-agy");
  assert.ok(textParticipant);
  assert.ok(agyParticipant);
  for (const [participant, requestedModel] of [
    [textParticipant, "text-requested-model"],
    [agyParticipant, "agy-requested-model"]
  ]) {
    assert.equal(participant.metadata.requestedModel, requestedModel);
    assert.equal(participant.metadata.reportedModel, null);
    assert.equal(participant.metadata.modelAssurance, "requested-not-attested");
  }
  assert.equal(roster.arbiter, null);
});

test("denied external catalogs emit unavailable evidence without discovery, probes, or cache reuse", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-catalog-authority-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const kind of ["static", "command"]) {
    const calls = path.join(directory, `${kind}-calls`);
    const quotedCalls = calls.replaceAll("'", "'\\''");
    const fake = await executable(directory, kind,
      `printf '%s\\n' "$1" >> '${quotedCalls}'\ncase "$1" in models) printf '{"models":["current-model"]}\\n' ;; *) printf 'SBW_TEST_MARKER\\n' ;; esac`);
    const provider = {
      id: "fake", command: fake, probe: "text", external: true,
      supportedBrands: ["Fake"], role: "test-role", capabilityRank: 1,
      ...(kind === "static"
        ? { models: [{ model: "current-model", brand: "Fake", role: "test-role", capabilityRank: 1 }] }
        : { modelDiscovery: { key: "shared-catalog", type: "command", args: ["models"], format: "json-v1", defaultBrand: "Fake" } })
    };
    const config = {
      schemaVersion: 3,
      terminology: { modelBrands: ["Fake"], transportCommand: fake, transportModelBrands: ["Fake"], transportIsModelBrand: false },
      probeMarker: "SBW_TEST_MARKER", probeTimeoutSeconds: 5, rosterCacheHours: 24, maxParticipants: 3,
      providers: [provider], arbiterPriority: [{ provider: "fake", brand: "Fake" }]
    };
    const options = { config, stateRoot: path.join(directory, `${kind}-state`), timeoutSeconds: 5 };
    const deniedFlags = [
      { allowExternalProviders: false, sanitized: false },
      { allowExternalProviders: true, sanitized: false },
      { allowExternalProviders: false, sanitized: true }
    ];
    for (const flags of deniedFlags) {
      const denied = await probeDeliberationRoster({ ...options, ...flags });
      assert.deepEqual(denied.activeParticipants, []);
      assert.equal(denied.arbiter, null);
      assert.equal(denied.modelCatalog[0].status, "requires-authority");
      assert.deepEqual(denied.modelCatalog[0].models, []);
      assert.equal(denied.unavailable.length, 1);
      assert.match(denied.unavailable[0].reason, /allow-external-providers and --sanitized/);
      assert.equal(denied.cache.status, "bypassed");
      await assert.rejects(access(calls), { code: "ENOENT" });
      await assert.rejects(access(options.stateRoot), { code: "ENOENT" });
    }
    const authorized = await probeDeliberationRoster({ ...options, allowExternalProviders: true, sanitized: true });
    assert.equal(authorized.activeParticipants.length, 1);
    assert.equal(authorized.cache.status, "stored");
    const priorCalls = await readFile(calls, "utf8");
    const deniedAfterCache = await probeDeliberationRoster({ ...options, ...deniedFlags[0] });
    assert.deepEqual(deniedAfterCache.activeParticipants, []);
    assert.equal(deniedAfterCache.cache.status, "bypassed");
    assert.equal(await readFile(calls, "utf8"), priorCalls);

    if (kind === "command") {
      // A shared catalog cannot grant authority, nor may a denied provider
      // prevent an independently permitted local participant from being probed.
      for (const externalFirst of [true, false]) {
        const local = { ...provider, id: "local", external: false };
        const mixed = { ...config, providers: externalFirst ? [provider, local] : [local, provider] };
        const result = await probeDeliberationRoster({ ...options, config: mixed, ...deniedFlags[0] });
        assert.deepEqual(result.activeParticipants.map(item => item.provider), ["local"]);
        assert.equal(result.modelCatalog.find(item => item.provider === "fake").status, "requires-authority");
        assert.equal(result.modelCatalog.find(item => item.provider === "local").status, "discovered");
      }
    }
  }
});

test("deliberation roster caches only a fresh, CLI-proven full external roster", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-deliberation-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
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
  assert.equal(first.activeParticipants[0].metadata.requestedModel, "Fake Model");
  assert.equal(first.activeParticipants[0].metadata.reportedModel, null);

  const cacheFile = path.join(options.stateRoot, "deliberation-roster-cache-high.json");
  const stale = JSON.parse(await readFile(cacheFile, "utf8"));
  stale.schemaVersion = 3;
  stale.result.activeParticipants[0].metadata.reportedModel = "legacy-fake-model";
  await writeFile(cacheFile, `${JSON.stringify(stale)}\n`);
  const second = await probeDeliberationRoster(options);
  assert.equal(second.activeParticipants.length, 1);
  assert.equal(second.cache.status, "stored");
  assert.equal(second.activeParticipants[0].metadata.requestedModel, "Fake Model");
  assert.equal(second.activeParticipants[0].metadata.reportedModel, null);
  const refreshed = JSON.parse(await readFile(cacheFile, "utf8"));
  assert.equal(refreshed.schemaVersion, 4);
  assert.equal(refreshed.result.activeParticipants[0].metadata.reportedModel, null);

  const third = await probeDeliberationRoster(options);
  assert.equal(third.cache.status, "hit");
  assert.equal(third.activeParticipants[0].metadata.requestedModel, "Fake Model");
  assert.equal(third.activeParticipants[0].metadata.reportedModel, null);

  await writeFile(fake, "#!/bin/sh\nprintf 'SBW_TEST_MARKER\\n'\n# changed binary identity\n", { mode: 0o700 });
  await chmod(fake, 0o700);
  const fourth = await probeDeliberationRoster(options);
  assert.equal(fourth.activeParticipants.length, 1);
  assert.equal(fourth.cache.status, "stored");
  assert.equal(fourth.activeParticipants[0].metadata.reportedModel, null);
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
