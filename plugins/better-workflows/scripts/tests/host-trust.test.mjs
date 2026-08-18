import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  createHash,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  authoritativeBlobAtRevisionFromGit,
  authoritativeTreeEntryFromGit,
  authoritativeLocalGitValues,
  authoritativeEvidenceIndex,
  buildEvaluatorInferenceInput,
  canonicalJson,
  EVALUATION_SCHEMA,
  evaluatorCommandArgs,
  HOST_CRITICAL_MATERIAL_ANCHOR_SOURCE,
  HOST_MATERIAL_SAMPLE_PRIORITY,
  evaluatorFeatureProbeArgs,
  evaluatorModelCatalog,
  evaluatorRegistryProbeArgs,
  evaluatorToolProbeArgs,
  forwardedHeaders,
  literalAuthoritativeGitPathspec,
  optionalAuthoritativeGitOutput,
  parseOptionalAuthoritativeSymbolicRef,
  parseAuthoritativeTreeEntry,
  parseEvaluatorTranscript,
  parseInternalReadinessTranscript,
  privateKeyFromRaw,
  reconstructPluginBundleDigest,
  standingConsentSudoers,
  standingConsentSudoersEvidence,
  validateStandingConsentPolicy,
  validateSigningKeyPair,
  spawnCapture,
  startEvaluatorRequestGate,
  startEvaluatorRequestGateForTest,
  buildAuthoritativeEvaluationPrompt,
  validateAuthoritativeStandingManifestBindings,
  validateAuthoritativeStandingRequestBindings,
  validateAuthoritativeMaterialBytes,
  validateAuthoritativePromptPaths,
  validateEvaluatorFeatureProbeOutput,
  validateEvaluatorRequestCardinality,
  validateEvaluatorRegistryProbeRequest,
  validateEvaluatorClientHeaders,
  evaluatorForwardHeaderPolicy,
  validateNativeReviewRequest,
  terminateProcessGroupForTest,
  validateExecutionRequest,
  validateProtectedDirectoryChain,
  validateProtectedParentChain
} from "../host-trust.mjs";
import { createBundleManifest } from "../lib/publication.mjs";
import {
  buildEvaluationPrompt,
  SELF_IMPROVE_CRITICAL_MATERIAL_ANCHOR_SOURCE,
  SELF_IMPROVE_MATERIAL_SAMPLE_PRIORITY
} from "../lib/self-improve.mjs";
import { nativeCriticBindingFields } from "../lib/providers.mjs";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "host-trust.mjs"
);
const execFileAsync = promisify(execFile);
const STANDING_CONSENT_POLICY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../config/self-improve-standing-consent-v1.json"
);

function evaluatorOutputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: { results: { type: "array", items: { type: "string" } } }
  };
}

test("host authoritative optional Git reads distinguish only exact absence", () => {
  const absent = {
    ok: false,
    code: 1,
    signal: null,
    timedOut: false,
    outputExceeded: false,
    stdout: "",
    stderr: ""
  };
  assert.equal(optionalAuthoritativeGitOutput(absent, "symbolic ref"), null);
  assert.deepEqual(authoritativeLocalGitValues(absent, "remote.origin.pushurl"), []);
  assert.deepEqual(authoritativeLocalGitValues({
    ok: true,
    code: 0,
    signal: null,
    timedOut: false,
    outputExceeded: false,
    stdout: "https://github.com/example/repository.git\0https://github.com/example/repository-push.git\0",
    stderr: ""
  }, "remote.origin.url"), [
    "https://github.com/example/repository.git",
    "https://github.com/example/repository-push.git"
  ]);

  for (const failure of [
    { ...absent, code: "1" },
    { ...absent, timedOut: true },
    { ...absent, outputExceeded: true },
    { ...absent, signal: "SIGKILL" },
    { ...absent, code: 128 },
    { ...absent, code: null }
  ]) {
    assert.throws(
      () => authoritativeLocalGitValues(failure, "remote.origin.pushurl"),
      /Authoritative local Git config read.*failed/
    );
    assert.throws(
      () => optionalAuthoritativeGitOutput(failure, "symbolic ref"),
      /symbolic ref failed/
    );
  }
  assert.throws(
    () => authoritativeLocalGitValues({ ...absent, ok: true, code: 0, stdout: "unterminated" }, "remote.origin.url"),
    /unterminated local Git values/
  );
  assert.throws(
    () => authoritativeLocalGitValues({ ...absent, ok: true, code: 0, stdout: "line1\nline2\0" }, "remote.origin.url"),
    /invalid local Git value/
  );
});

test("host authoritative symbolic refs require exact framed text successes", () => {
  assert.equal(parseOptionalAuthoritativeSymbolicRef(null), null);
  assert.equal(parseOptionalAuthoritativeSymbolicRef("refs/heads/dev\n"), "refs/heads/dev");
  for (const output of [
    "",
    "refs/heads/dev",
    " refs/heads/dev\n",
    "refs/heads/dev \n",
    "refs/heads/dev\r\n",
    "refs/heads/dev\0\n",
    "refs/heads/dev\nrefs/heads/other\n",
    Buffer.from("refs/heads/dev\n")
  ]) {
    assert.throws(() => parseOptionalAuthoritativeSymbolicRef(output), /malformed success output/);
  }
});

test("root-authoritative tree reads literalize magic-prefixed tracked filenames", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "sbw-host-literal-tree-"));
  try {
    await execFileAsync("/usr/bin/git", ["init", "-q", "-b", "dev"], { cwd: repo });
    await execFileAsync("/usr/bin/git", ["config", "user.name", "Better Workflows Tests"], { cwd: repo });
    await execFileAsync("/usr/bin/git", ["config", "user.email", "tests@example.invalid"], { cwd: repo });
    const file = ":(top)NO_SUCH";
    await writeFile(path.join(repo, file), "baseline\n");
    await execFileAsync("/usr/bin/git", ["add", "."], { cwd: repo });
    await execFileAsync("/usr/bin/git", ["commit", "-qm", "literal baseline"], { cwd: repo });
    const baseline = (await execFileAsync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await writeFile(path.join(repo, file), "candidate\n");
    await execFileAsync("/usr/bin/git", ["add", "."], { cwd: repo });
    await execFileAsync("/usr/bin/git", ["commit", "-qm", "literal candidate"], { cwd: repo });
    const head = (await execFileAsync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    const calls = [];
    const runGit = async (cwd, _subject, args, options = {}) => {
      calls.push(args);
      const result = await execFileAsync("/usr/bin/git", args, {
        cwd,
        encoding: options.binary ? "buffer" : "utf8"
      });
      return { stdout: result.stdout };
    };
    const baseEntry = await authoritativeTreeEntryFromGit(runGit, repo, {}, baseline, file);
    const headEntry = await authoritativeTreeEntryFromGit(runGit, repo, {}, head, file);
    const baseBlob = await authoritativeBlobAtRevisionFromGit(runGit, repo, {}, baseline, file);
    const headBlob = await authoritativeBlobAtRevisionFromGit(runGit, repo, {}, head, file);
    assert.equal(baseEntry.path, file);
    assert.equal(baseEntry.type, "blob");
    assert.equal(baseEntry.mode, "100644");
    assert.equal(headEntry.path, file);
    assert.notEqual(headEntry.object, baseEntry.object);
    assert.equal(baseBlob.bytes.toString("utf8"), "baseline\n");
    assert.equal(headBlob.bytes.toString("utf8"), "candidate\n");
    assert.equal(baseBlob.mode, 0o644);
    assert.equal(headBlob.mode, 0o644);
    assert.deepEqual(calls.filter((args) => args[0] === "ls-tree").map((args) => args.at(-1)), [
      literalAuthoritativeGitPathspec(file),
      literalAuthoritativeGitPathspec(file),
      literalAuthoritativeGitPathspec(file),
      literalAuthoritativeGitPathspec(file)
    ]);
    assert.deepEqual(calls.filter((args) => args[0] === "cat-file"), [
      ["cat-file", "blob", baseEntry.object],
      ["cat-file", "blob", headEntry.object]
    ]);
    assert.equal(parseAuthoritativeTreeEntry("", file), null);
    for (const output of [
      `100644 blob ${"a".repeat(40)}\t${file}`,
      `100644 blob ${"a".repeat(40)}\twrong\0`,
      `100644 blob ${"a".repeat(40)}\t${file}\u0000100644 blob ${"b".repeat(40)}\t${file}\0`,
      `100644 blob invalid\t${file}\0`
    ]) {
      assert.throws(() => parseAuthoritativeTreeEntry(output, file), /tree lookup/);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("root host and plugin evaluator material policies stay exactly aligned", () => {
  assert.deepEqual(HOST_MATERIAL_SAMPLE_PRIORITY, SELF_IMPROVE_MATERIAL_SAMPLE_PRIORITY);
  assert.equal(HOST_CRITICAL_MATERIAL_ANCHOR_SOURCE, SELF_IMPROVE_CRITICAL_MATERIAL_ANCHOR_SOURCE);
});

test("native review signer accepts execution-bound v2 requests without weakening legacy bindings", () => {
  const legacy = {
    base: "a".repeat(40),
    head: "b".repeat(40),
    instructionDigest: "c".repeat(64),
    model: "gpt-5.6-codex",
    packageId: "review-package",
    promptDigest: "d".repeat(64),
    reviewDigest: "e".repeat(64),
    reviewerId: "reviewer-1",
    runId: "run-review-1",
    sentinelDigest: "f".repeat(64)
  };
  assert.deepEqual(validateNativeReviewRequest(legacy), legacy);
  assert.deepEqual(Object.keys(legacy).sort(), nativeCriticBindingFields(legacy).sort());
  const executionBound = { ...legacy, executionId: "axis:context-rich:1" };
  assert.deepEqual(validateNativeReviewRequest(executionBound), executionBound);
  assert.deepEqual(Object.keys(executionBound).sort(), nativeCriticBindingFields(executionBound).sort());
  assert.throws(
    () => validateNativeReviewRequest({ ...executionBound, executionId: "unsafe/execution" }),
    /executionId is invalid/
  );
  assert.throws(
    () => validateNativeReviewRequest({ ...executionBound, unbound: true }),
    /fields do not match/
  );
});

function validEvaluatorClientRequest(model, inputText, outputSchema) {
  const message = (role, text, id = null) => ({
    type: "message",
    role,
    ...(id ? { id } : {}),
    content: [{ type: "input_text", text }]
  });
  return {
    client_metadata: {
      session_id: "session-test",
      thread_id: "thread-test",
      turn_id: "turn-test",
      "x-codex-installation-id": "installation-test",
      "x-codex-turn-metadata": "{}",
      "x-codex-window-id": "window-test"
    },
    include: ["reasoning.encrypted_content"],
    input: [
      { type: "additional_tools", role: "developer", tools: [] },
      message("developer", "root developer instructions"),
      {
        type: "message",
        role: "developer",
        id: "A".repeat(40),
        content: [
          { type: "input_text", text: "root developer context" },
          { type: "input_text", text: "root safety context" }
        ]
      },
      message("user", "root environment context", "B".repeat(40)),
      message("user", inputText, "C".repeat(40))
    ],
    model,
    parallel_tool_calls: false,
    prompt_cache_key: "00000000-0000-4000-8000-000000000001",
    reasoning: { effort: "high", context: "all_turns" },
    store: false,
    stream: true,
    text: {
      format: {
        type: "json_schema",
        strict: true,
        schema: structuredClone(outputSchema),
        name: "codex_output_schema"
      }
    },
    tool_choice: "auto"
  };
}

function capturingEvaluatorTransport({ holdResponse = false } = {}) {
  const state = { captured: null, destroyed: false };
  const transport = (options, callback) => {
    const upstreamRequest = new EventEmitter();
    upstreamRequest.writableFinished = false;
    upstreamRequest.end = (body) => {
      state.captured = { options, body: Buffer.from(body) };
      upstreamRequest.writableFinished = true;
      if (!holdResponse) {
        queueMicrotask(() => {
          const upstreamResponse = Readable.from([Buffer.from("data: evaluator-ok\\n\\n")]);
          upstreamResponse.statusCode = 200;
          upstreamResponse.headers = { "content-type": "text/event-stream" };
          callback(upstreamResponse);
        });
      }
    };
    upstreamRequest.destroy = (error) => {
      state.destroyed = true;
      if (error && !upstreamRequest.writableFinished) upstreamRequest.emit("error", error);
      queueMicrotask(() => upstreamRequest.emit("close"));
    };
    return upstreamRequest;
  };
  return { state, transport };
}

async function sendEvaluatorClientRequest(gate, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const target = new URL(`${gate.baseUrl}/responses`);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        authorization: "Bearer test-only",
        "content-type": "application/json",
        "content-length": String(body.length)
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("host signer reconstructs Ed25519 keys and signs canonical verifier payloads", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const reconstructed = privateKeyFromRaw(seed);
  const payload = {
    execution: { role: "candidate", attempt: 1 },
    provider: "codex",
    schemaVersion: 1
  };
  const bytes = Buffer.from(canonicalJson(payload), "utf8");
  const signature = sign(null, bytes, reconstructed);
  assert.equal(verify(null, bytes, publicKey, signature), true);
});

test("host execution response schema defines array items for Codex structured output", () => {
  const results = EVALUATION_SCHEMA.properties.results;
  assert.equal(results.type, "array");
  assert.equal(results.items.type, "object");
  assert.deepEqual(results.items.required, ["id", "disposition", "passedAssertions"]);
  assert.equal(results.items.properties.passedAssertions.type, "array");
  assert.equal(results.items.properties.passedAssertions.items.type, "string");
});

test("host readiness and execution share the exact evaluator policy argv", () => {
  const options = {
    workingDirectory: "/private/var/db/better-workflows/execution-bundles/probe",
    schemaPath: "/private/var/db/better-workflows/execution-bundles/probe/evaluation.schema.json",
    modelCatalogPath: "/private/var/db/better-workflows/execution-bundles/probe/evaluation.model-catalog.json",
    model: "gpt-5.6-terra"
  };
  const execution = evaluatorCommandArgs(options);
  const readiness = evaluatorCommandArgs({ ...options, helpOnly: true });
  assert.deepEqual(readiness.slice(0, -1), execution.slice(0, -1));
  assert.equal(execution.at(-1), "-");
  assert.equal(readiness.at(-1), "--help");
  assert.ok(execution.includes("--strict-config"));
  assert.ok(execution.includes("--ignore-user-config"));
  assert.ok(execution.includes("--ignore-rules"));
  assert.ok(execution.includes("--json"));
  assert.ok(execution.includes("shell_tool"));
  assert.ok(execution.includes("unified_exec"));
  assert.ok(execution.includes("memories"));
  for (const config of [
    "tools.web_search=false",
    "web_search=\"disabled\"",
    "tools.experimental_request_user_input={enabled=false}",
    "tools.update_plan={enabled=false}",
    "orchestrator.skills.enabled=false",
    "mcp_servers={}"
  ]) assert.ok(execution.includes(config));
  assert.ok(execution.includes(`model_catalog_json=${JSON.stringify(options.modelCatalogPath)}`));
  const catalog = evaluatorModelCatalog(options.model);
  assert.equal(catalog.models[0].comp_hash, "3000");
  assert.equal(catalog.models[0].shell_type, "disabled");
  assert.equal(catalog.models[0].supports_search_tool, false);
  assert.equal(catalog.models[0].tool_mode, null);
  assert.equal(catalog.models[0].multi_agent_version, null);
  assert.throws(() => evaluatorModelCatalog("gpt-5.6-sol"), /only permits gpt-5\.6-terra/);
  const featureProbe = evaluatorFeatureProbeArgs();
  assert.deepEqual(featureProbe.slice(-2), ["features", "list"]);
  assert.equal(featureProbe.includes("--help"), false);
  assert.ok(featureProbe.includes("memories"));
  const disabled = featureProbe.slice(0, -2).filter((_, index) => index % 2 === 1);
  const output = disabled.map((feature) => `${feature} stable false`).join("\n");
  assert.deepEqual(validateEvaluatorFeatureProbeOutput(output), disabled);
  assert.throws(
    () => validateEvaluatorFeatureProbeOutput(output.replace("memories stable false", "memories stable true")),
    /required disabled feature set: memories/
  );
  assert.deepEqual(evaluatorToolProbeArgs(options), execution);
  const registryProbe = evaluatorRegistryProbeArgs({
    ...options,
    baseUrl: `http://127.0.0.1:43123/v1/${"a".repeat(64)}`
  });
  for (const config of [
    'model_provider="better_workflows_evaluator"',
    'model_providers.better_workflows_evaluator.name="Better Workflows Evaluator"',
    `model_providers.better_workflows_evaluator.base_url="http://127.0.0.1:43123/v1/${"a".repeat(64)}"`,
    'model_providers.better_workflows_evaluator.wire_api="responses"',
    "model_providers.better_workflows_evaluator.requires_openai_auth=true",
    "model_providers.better_workflows_evaluator.supports_websockets=false"
  ]) {
    const index = registryProbe.indexOf(config);
    assert.ok(index > 0);
    assert.equal(registryProbe[index - 1], "-c");
  }
  const normalizedRegistryProbe = [];
  for (let index = 0; index < registryProbe.length; index += 1) {
    if (registryProbe[index] === "-c" && String(registryProbe[index + 1] ?? "").startsWith("model_provider")) {
      index += 1;
      continue;
    }
    normalizedRegistryProbe.push(registryProbe[index]);
  }
  assert.deepEqual(normalizedRegistryProbe, execution);
});

test("host evaluator request gate enforces a total deadline on incomplete requests", async () => {
  const challenge = "a".repeat(64);
  const input = buildEvaluatorInferenceInput(Buffer.from("deadline probe\n"), challenge).toString("utf8");
  const outputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: { results: { type: "array", items: { type: "string" } } }
  };
  const gate = await startEvaluatorRequestGate({
    model: "gpt-5.6-terra",
    expectedChallenge: challenge,
    expectedInputText: input,
    expectedOutputSchema: outputSchema,
    timeoutMs: 50
  });
  const target = new URL(`${gate.baseUrl}/responses`);
  const client = httpRequest({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: "POST",
    headers: {
      authorization: "Bearer test-only",
      "content-type": "application/json",
      "content-length": "100"
    }
  });
  client.on("error", () => undefined);
  try {
    await new Promise((resolve, reject) => client.write("{", (error) => error ? reject(error) : resolve()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(() => gate.finish(), /exceeded its 50ms total deadline/);
  } finally {
    client.destroy();
    await gate.close();
  }
});

test("host evaluator request gate forwards one canonical request and rejects extras", async () => {
  const challenge = "c".repeat(64);
  const input = buildEvaluatorInferenceInput(Buffer.from("live forwarding probe\n"), challenge).toString("utf8");
  const outputSchema = evaluatorOutputSchema();
  const clientRequest = validEvaluatorClientRequest("gpt-5.6-terra", input, outputSchema);
  const recorder = capturingEvaluatorTransport();
  const gate = await startEvaluatorRequestGateForTest({
    model: "gpt-5.6-terra",
    expectedChallenge: challenge,
    expectedInputText: input,
    expectedOutputSchema: outputSchema
  }, recorder.transport);
  try {
    const first = await sendEvaluatorClientRequest(gate, clientRequest);
    assert.equal(first.statusCode, 200);
    assert.match(first.body, /^data: evaluator-ok/);
    const proof = await gate.finish();
    assert.equal(proof.requestCount, 1);
    assert.ok(recorder.state.captured);
    const expectedBody = Buffer.from(canonicalJson({
      model: "gpt-5.6-terra",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: input }]
      }],
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
    }));
    assert.deepEqual(recorder.state.captured.body, expectedBody);
    assert.deepEqual(recorder.state.captured.options.headers, {
      accept: "text/event-stream",
      "accept-encoding": "identity",
      authorization: "Bearer test-only",
      host: "chatgpt.com",
      "content-type": "application/json",
      "content-length": String(expectedBody.length),
      originator: "codex_cli_rs",
      "user-agent": "better-workflows-host-trust/3"
    });

    const extra = await sendEvaluatorClientRequest(gate, clientRequest);
    assert.equal(extra.statusCode, 502);
    await assert.rejects(gate.finish(), /unexpected extra inference request/);
  } finally {
    await gate.close();
  }
});

test("host evaluator request gate admits only the fixed read-only view-image bootstrap tool", async () => {
  const challenge = "f".repeat(64);
  const input = buildEvaluatorInferenceInput(Buffer.from("additional tool probe\n"), challenge).toString("utf8");
  const outputSchema = evaluatorOutputSchema();
  const request = validEvaluatorClientRequest("gpt-5.6-terra", input, outputSchema);
  request.input[0].tools = [{
    type: "function",
    name: "view_image",
    description: "View a local image file when visual inspection is needed.",
    strict: false,
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Local filesystem path to an image file." } },
      required: ["path"],
      additionalProperties: false
    }
  }];
  const recorder = capturingEvaluatorTransport();
  const gate = await startEvaluatorRequestGateForTest({
    model: "gpt-5.6-terra",
    expectedChallenge: challenge,
    expectedInputText: input,
    expectedOutputSchema: outputSchema
  }, recorder.transport);
  try {
    const response = await sendEvaluatorClientRequest(gate, request);
    assert.equal(response.statusCode, 200);
    assert.equal((await gate.finish()).requestCount, 1);
    const rejected = structuredClone(request);
    rejected.input[0].tools[0].name = "shell_tool";
    const secondGate = await startEvaluatorRequestGateForTest({
      model: "gpt-5.6-terra",
      expectedChallenge: challenge,
      expectedInputText: input,
      expectedOutputSchema: outputSchema
    }, capturingEvaluatorTransport().transport);
    try {
      assert.equal((await sendEvaluatorClientRequest(secondGate, rejected)).statusCode, 502);
      await assert.rejects(secondGate.finish(), /additional-tool bootstrap changed/);
    } finally {
      await secondGate.close();
    }
  } finally {
    await gate.close();
  }
});

test("host evaluator request gate rejects bootstrap mutation before forwarding", async () => {
  const challenge = "d".repeat(64);
  const input = buildEvaluatorInferenceInput(Buffer.from("mutation probe\n"), challenge).toString("utf8");
  const outputSchema = evaluatorOutputSchema();
  const mutated = validEvaluatorClientRequest("gpt-5.6-terra", input, outputSchema);
  mutated.input[4].content[0].text = `${input} attacker mutation`;
  const recorder = capturingEvaluatorTransport();
  const gate = await startEvaluatorRequestGateForTest({
    model: "gpt-5.6-terra",
    expectedChallenge: challenge,
    expectedInputText: input,
    expectedOutputSchema: outputSchema
  }, recorder.transport);
  try {
    const response = await sendEvaluatorClientRequest(gate, mutated);
    assert.equal(response.statusCode, 502);
    assert.equal(recorder.state.captured, null);
    await assert.rejects(gate.finish(), /exact root-generated inference input/);
  } finally {
    await gate.close();
  }
});

test("host evaluator request gate closes an upstream request when the downstream closes", async () => {
  const challenge = "e".repeat(64);
  const input = buildEvaluatorInferenceInput(Buffer.from("close probe\n"), challenge).toString("utf8");
  const outputSchema = evaluatorOutputSchema();
  const clientRequest = validEvaluatorClientRequest("gpt-5.6-terra", input, outputSchema);
  const recorder = capturingEvaluatorTransport({ holdResponse: true });
  const gate = await startEvaluatorRequestGateForTest({
    model: "gpt-5.6-terra",
    expectedChallenge: challenge,
    expectedInputText: input,
    expectedOutputSchema: outputSchema,
    timeoutMs: 500
  }, recorder.transport);
  try {
    const body = Buffer.from(JSON.stringify(clientRequest), "utf8");
    const target = new URL(`${gate.baseUrl}/responses`);
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        authorization: "Bearer test-only",
        "content-type": "application/json",
        "content-length": String(body.length)
      }
    });
    request.on("error", () => undefined);
    request.end(body);
    await new Promise((resolve) => setTimeout(resolve, 20));
    request.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(recorder.state.destroyed, true);
  } finally {
    await gate.close();
  }
});

test("host evaluator request gate rejects non-canonical upstream variants", async () => {
  const challenge = "b".repeat(64);
  const input = buildEvaluatorInferenceInput(Buffer.from("upstream binding probe\n"), challenge).toString("utf8");
  const outputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: { results: { type: "array", items: { type: "string" } } }
  };
  await assert.rejects(
    startEvaluatorRequestGate({
      model: "gpt-5.6-terra",
      expectedChallenge: challenge,
      expectedInputText: input,
      expectedOutputSchema: outputSchema,
      upstreamBaseUrl: "https://chatgpt.com:444/backend-api/codex/"
    }),
    /fixed authenticated Codex upstream/
  );
});

test("host evaluator forwarding retains only validated authorization and fixed protocol headers", () => {
  const forwarded = forwardedHeaders({
    authorization: "Bearer test-only",
    accept: "application/json",
    "content-type": "application/json",
    "content-length": "17"
  }, "127.0.0.1:43123", 17);
  assert.deepEqual(forwarded.headers, {
    accept: "text/event-stream",
    "accept-encoding": "identity",
    authorization: "Bearer test-only",
    host: "127.0.0.1:43123",
    "content-type": "application/json",
    "content-length": "17",
    originator: "codex_cli_rs",
    "user-agent": "better-workflows-host-trust/3"
  });
  assert.match(forwarded.policyDigest, /^[a-f0-9]{64}$/);
  const custom = forwardedHeaders({ "openai-beta": "responses=1", "x-feature-routing": "attacker-route", authorization: "Bearer test-only" }, "127.0.0.1:43123", 1);
  assert.equal(custom.headers.authorization, "Bearer test-only");
  assert.equal(Object.hasOwn(custom.headers, "openai-beta"), false);
  assert.equal(Object.hasOwn(custom.headers, "x-feature-routing"), false);
});

test("host registry probe positively requires an empty Responses API tool registry", () => {
  const challenge = "a".repeat(64);
  const inferenceInput = buildEvaluatorInferenceInput(Buffer.from("registry probe\n"), challenge).toString("utf8");
  const outputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: { results: { type: "array", items: { type: "string" } } }
  };
  const request = {
    model: "gpt-5.6-terra",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: inferenceInput }]
    }],
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
  };
  const proof = validateEvaluatorRegistryProbeRequest(request, "gpt-5.6-terra", challenge, inferenceInput, outputSchema);
  assert.equal(proof.toolCount, 0);
  assert.equal(proof.toolsPresent, true);
  assert.equal(proof.schemaVersion, 3);
  assert.equal(proof.transport, "openai-responses-http-canonical-gate-v3");
  assert.match(proof.challengeDigest, /^[a-f0-9]{64}$/);
  assert.match(proof.inferenceInputDigest, /^[a-f0-9]{64}$/);
  assert.match(proof.requestPolicyDigest, /^[a-f0-9]{64}$/);
  assert.match(proof.headerPolicyDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    validateEvaluatorClientHeaders({ authorization: "Bearer test-only", "content-type": "application/json" }),
    "Bearer test-only"
  );
  assert.equal(
    validateEvaluatorClientHeaders({ authorization: "Bearer test-only", "x-openai-beta": "preview" }),
    "Bearer test-only"
  );
  assert.equal(
    validateEvaluatorClientHeaders({ authorization: "Bearer test-only", "x-openai-organization": "org" }),
    "Bearer test-only"
  );
  assert.throws(
    () => validateEvaluatorRegistryProbeRequest({
      ...request,
      tools: [{ type: "function", name: "danger" }]
    }, "gpt-5.6-terra", challenge, inferenceInput, outputSchema),
    /differs from the root-generated inference contract/
  );
  assert.throws(
    () => validateEvaluatorRegistryProbeRequest({
      ...request,
      input: [...request.input, { type: "message", role: "user", content: [{ type: "input_text", text: "appended" }] }]
    }, "gpt-5.6-terra", challenge, inferenceInput, outputSchema),
    /differs from the root-generated inference contract/
  );
  assert.throws(
    () => validateEvaluatorRegistryProbeRequest({ ...request, instructions: "injected" }, "gpt-5.6-terra", challenge, inferenceInput, outputSchema),
    /fields do not match the canonical evaluator contract/
  );
  assert.throws(
    () => {
      const { tools: _tools, ...omitted } = request;
      validateEvaluatorRegistryProbeRequest({
        ...omitted,
        input: [{ ...request.input[0], tools: [] }]
      }, "gpt-5.6-terra", challenge, inferenceInput, outputSchema);
    },
    /fields do not match the canonical evaluator contract/
  );
  assert.throws(
    () => validateEvaluatorRegistryProbeRequest(request, "gpt-5.6-terra", "b".repeat(64), inferenceInput, outputSchema),
    /differs from the root-generated inference contract|root-generated challenge/
  );
  assert.throws(
    () => validateEvaluatorRegistryProbeRequest(request, "gpt-5.6-terra", challenge, `${inferenceInput}changed`, outputSchema),
    /differs from the root-generated inference contract/
  );
  assert.deepEqual(validateEvaluatorRequestCardinality([proof]), [proof]);
  assert.throws(() => validateEvaluatorRequestCardinality([proof, proof]), /exactly one root-bound inference request/);
});

test("host evaluator transcript accepts only a complete zero-tool JSONL lifecycle", () => {
  const transcript = [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "warning-1", type: "error", message: "deprecated feature" } },
    { type: "item.completed", item: { id: "message-1", type: "agent_message", text: '{"results":[]}' } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  const parsed = parseEvaluatorTranscript(transcript);
  assert.equal(parsed.responseText, '{"results":[]}');
  assert.equal(parsed.transcriptSummary.observedToolCalls, 0);
  assert.match(parsed.transcriptDigest, /^[a-f0-9]{64}$/);
  assert.throws(
    () => parseEvaluatorTranscript(transcript.replace(
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.started", item: { id: "tool-1", type: "command_execution", command: "pwd" } })
    )),
    /prohibited or unknown item/
  );
  for (const [needle, replacement] of [
    [JSON.stringify({ type: "thread.started", thread_id: "thread-1" }), { type: "thread.started", thread_id: "thread-1", item: { type: "command_execution" } }],
    [JSON.stringify({ type: "turn.started" }), { type: "turn.started", item: { type: "command_execution" } }],
    [JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }), { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 }, item: { type: "command_execution" } }],
    [JSON.stringify({ type: "item.completed", item: { id: "warning-1", type: "error", message: "deprecated feature" } }), { type: "item.completed", item: { id: "warning-1", type: "error", message: "deprecated feature", tool_call: "unexpected" } }]
  ]) {
    assert.throws(() => parseEvaluatorTranscript(transcript.replace(needle, JSON.stringify(replacement))), /schema is invalid|prohibited or unknown/);
  }
});

test("host evaluator transcript accepts Codex prelude warnings and full usage counters", () => {
  const transcript = [
    { type: "thread.started", thread_id: "thread-real" },
    { type: "item.completed", item: { id: "warning-real", type: "error", message: "deprecated feature" } },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "message-real", type: "agent_message", text: '{"results":[]}' } },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 9, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 2 } }
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  assert.equal(parseEvaluatorTranscript(transcript).responseText, '{"results":[]}');
  assert.throws(
    () => parseEvaluatorTranscript(`${transcript}${JSON.stringify({ type: "item.completed", item: { id: "message-2", type: "agent_message", text: "second" } })}\n`),
    /lifecycle is incomplete or ambiguous|prohibited or unknown/
  );
});

test("host native readiness uses its exact one-result transcript contract", () => {
  const response = {
    results: [{ id: "host-readiness-probe", disposition: "NO_CHANGE", passedAssertions: [] }],
    probe: {
      uid: 501,
      euid: 501,
      gid: 20,
      egid: 20,
      supplementaryGroups: [],
      cwd: "/private/var/db/better-workflows/execution-bundles/probe",
      argv0: "/private/var/db/better-workflows/executions/probe.codex",
      environment: ["HOME=/Users/test", "PATH=/usr/bin:/bin"]
    }
  };
  const raw = `${JSON.stringify(response)}\n`;
  const parsed = parseInternalReadinessTranscript(raw);
  assert.deepEqual(parsed.response, response);
  assert.deepEqual(parsed.transcriptSummary.eventTypes, [{ type: "internal.readiness.result", count: 1 }]);
  assert.equal(parsed.transcriptSummary.observedToolCalls, 0);
  assert.throws(
    () => parseInternalReadinessTranscript(`${raw}${raw}`),
    /exactly one JSON result/
  );
  assert.throws(
    () => parseInternalReadinessTranscript(`${JSON.stringify({ ...response, unexpected: true })}\n`),
    /fields do not match/
  );
  assert.throws(
    () => parseInternalReadinessTranscript(`${JSON.stringify({
      ...response,
      results: [{ id: "host-readiness-probe", disposition: "IMPLEMENT", passedAssertions: [] }]
    })}\n`),
    /evaluation result is invalid/
  );
});

test("authoritative material bytes must match the reconstructed snapshot before sampling", () => {
  const content = Buffer.from("snapshot-bound\n", "utf8");
  const file = {
    path: "plugins/better-workflows/scripts/lib/candidate.mjs",
    state: "file",
    size: content.length,
    digest: createHash("sha256").update(content).digest("hex")
  };
  assert.equal(validateAuthoritativeMaterialBytes(file, content), content);
  assert.throws(
    () => validateAuthoritativeMaterialBytes(file, Buffer.from("swapped-after-snapshot\n", "utf8")),
    /do not match the reconstructed snapshot/
  );
});

test("authoritative prompt scanning rejects credentials in every changed path state", async () => {
  const policy = JSON.parse(await readFile(STANDING_CONSENT_POLICY, "utf8"));
  assert.doesNotThrow(() => validateAuthoritativePromptPaths([
    { path: "plugins/better-workflows/scripts/lib/safe.mjs", state: "file" },
    { path: "plugins/better-workflows/scripts/lib/deleted.mjs", state: "missing" }
  ], policy));
  const secretFamilies = [
    `ghp_${"A".repeat(20)}`,
    ["sk", "live", "B".repeat(24)].join("_"),
    ["sk", "test", "C".repeat(24)].join("_"),
    ["xoxc", "D".repeat(20)].join("-"),
    ["xoxe", "E".repeat(20)].join("-")
  ];
  for (const state of ["file", "missing"]) {
    for (const secret of secretFamilies) {
      assert.throws(
        () => validateAuthoritativePromptPaths([{
          path: `plugins/better-workflows/scripts/lib/${secret}.mjs`,
          state
        }], policy),
        /path contains secret-shaped content/
      );
    }
  }
});

test("root plugin reconstruction matches the canonical publication bundle digest", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "bw-host-bundle-digest-"));
  const plugin = path.join(repository, "plugins", "better-workflows");
  await mkdir(path.join(plugin, "nested"), { recursive: true });
  await writeFile(path.join(plugin, "alpha.txt"), "alpha\n");
  await writeFile(path.join(plugin, "nested", "beta.json"), `${JSON.stringify({ beta: true })}\n`);
  try {
    assert.equal(
      await reconstructPluginBundleDigest(repository),
      createHash("sha256").update(JSON.stringify(await createBundleManifest(plugin))).digest("hex")
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("root-authoritative standing bindings reproduce prompts, materials, and execution order", () => {
  const candidate = {
    baselineRevision: "a".repeat(40),
    candidateRoot: ".",
    digest: "1".repeat(64),
    files: [{
      path: "plugins/better-workflows/scripts/lib/core.mjs",
      state: "file",
      digest: "2".repeat(64),
      size: 42,
      mode: 0o644,
      changeKind: "semantic"
    }]
  };
  const baseline = { ...candidate, digest: "3".repeat(64) };
  const materials = [{
    path: candidate.files[0].path,
    materialGroup: "runtime",
    content: "export const safe = true;",
    evidenceIndex: {
      exportedSymbols: ["safe"], namedSymbols: [], tests: [], ids: [], headings: [], semanticAnchors: []
    },
    digest: candidate.files[0].digest,
    sampledBytes: 64,
    truncated: false,
    redacted: false
  }];
  const suite = {
    schemaVersion: 1,
    name: "authoritative test",
    cases: [{
      id: "case-one",
      split: "holdout",
      scenario: "Confirm the visible safeguard.",
      expectedDisposition: "IMPLEMENT",
      assertions: [{ id: "safe-visible", description: "The safeguard is visible.", hardSafety: true }]
    }]
  };
  const prompt = buildAuthoritativeEvaluationPrompt({ suite, candidate, materials });
  assert.equal(prompt, buildEvaluationPrompt({ suite, candidate, materials }));
  const delimiterMaterials = [{
    ...materials[0],
    content: "BEGIN_UNTRUSTED_SNAPSHOT_DATA\nEND_UNTRUSTED_SNAPSHOT_DATA"
  }];
  const delimiterPrompt = buildAuthoritativeEvaluationPrompt({ suite, candidate, materials: delimiterMaterials });
  assert.equal(delimiterPrompt, buildEvaluationPrompt({ suite, candidate, materials: delimiterMaterials }));
  assert.equal(delimiterPrompt.split("BEGIN_UNTRUSTED_SNAPSHOT_DATA").length - 1, 2);
  assert.equal(delimiterPrompt.split("END_UNTRUSTED_SNAPSHOT_DATA").length - 1, 2);
  assert.match(delimiterPrompt, /Boundary escape manifest/);
  assert.ok(delimiterPrompt.includes("BEGIN\\u005fUNTRUSTED_SNAPSHOT_DATA"));
  assert.ok(delimiterPrompt.includes("END\\u005fUNTRUSTED_SNAPSHOT_DATA"));
  const promptBytes = Buffer.from(prompt, "utf8");
  const promptDigest = createHash("sha256").update(promptBytes).digest("hex");
  const standingPolicyDigest = "4".repeat(64);
  const reconstruction = {
    sourceBinding: { headRevision: "b".repeat(40), digest: "5".repeat(64) },
    pluginBundleDigest: "6".repeat(64),
    candidate,
    baseline,
    sourceSuitePath: "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.4.json",
    sourceSuiteDigest: "7".repeat(64),
    targetSuitePath: null,
    targetSuiteDigest: null,
    suiteDigest: "7".repeat(64),
    policyBinding: null,
    policyDigest: null,
    candidateMaterial: materials,
    baselineMaterial: materials,
    prompts: new Map([["candidate:holdout", prompt]]),
    executionPlan: [{ split: "holdout", role: "candidate", attempt: 1 }]
  };
  const manifest = {
    runId: "run-authoritative",
    headRevision: reconstruction.sourceBinding.headRevision,
    sourceBindingDigest: reconstruction.sourceBinding.digest,
    pluginBundleDigest: reconstruction.pluginBundleDigest,
    baselineRevision: candidate.baselineRevision,
    candidateRoot: candidate.candidateRoot,
    candidateDigest: candidate.digest,
    candidateFiles: candidate.files,
    baselineSnapshotDigest: baseline.digest,
    suitePath: reconstruction.sourceSuitePath,
    sourceSuiteDigest: reconstruction.sourceSuiteDigest,
    targetSuitePath: null,
    targetSuiteDigest: null,
    suiteDigest: reconstruction.suiteDigest,
    requests: [{
      executionId: "run-authoritative-holdout-candidate-1",
      role: "candidate",
      attempt: 1,
      promptDigest
    }]
  };
  assert.equal(validateAuthoritativeStandingManifestBindings(manifest, reconstruction), true);
  const files = candidate.files.map(({ path: filePath, state, digest, mode, size }) => ({
    path: filePath, state, digest, mode, size
  }));
  const request = {
    promptDigest,
    execution: { id: manifest.requests[0].executionId, promptDigest },
    materialBinding: {
      schemaVersion: 1,
      sanitizerPolicyDigest: standingPolicyDigest,
      snapshotDigest: candidate.digest,
      files,
      materialsDigest: createHash("sha256").update(canonicalJson(materials)).digest("hex")
    }
  };
  assert.equal(validateAuthoritativeStandingRequestBindings({
    manifest,
    item: manifest.requests[0],
    request,
    promptBytes,
    reconstruction,
    index: 0,
    standingPolicyDigest
  }), true);
  assert.throws(
    () => validateAuthoritativeStandingManifestBindings({ ...manifest, candidateRoot: "plugins" }, reconstruction),
    /root-authoritative repository/
  );
  assert.throws(
    () => validateAuthoritativeStandingRequestBindings({
      manifest,
      item: manifest.requests[0],
      request: { ...request, materialBinding: { ...request.materialBinding, materialsDigest: "8".repeat(64) } },
      promptBytes,
      reconstruction,
      index: 0,
      standingPolicyDigest
    }),
    /root-authoritative prompt/
  );
});

test("root-authoritative evidence indexes ignore regex literals after control-flow parentheses", () => {
  const evidence = authoritativeEvidenceIndex(
    "if (enabled) /export function forgedAnchor() {}/.test(input);\nexport function verifiedAnchor() {}\n",
    "plugins/better-workflows/scripts/lib/candidate.mjs"
  );
  assert.deepEqual(evidence.exportedSymbols, ["verifiedAnchor"]);
  assert.equal(evidence.namedSymbols.includes("forgedAnchor"), false);
});

test("root-authoritative evidence indexes ignore regex literals after control-flow blocks", () => {
  const evidence = authoritativeEvidenceIndex(
    "if (enabled) {} /export function forgedAnchor() {}/.test(input);\nexport function verifiedAnchor() {}\n",
    "plugins/better-workflows/scripts/lib/candidate.mjs"
  );
  assert.deepEqual(evidence.exportedSymbols, ["verifiedAnchor"]);
  assert.equal(evidence.namedSymbols.includes("forgedAnchor"), false);
});

test("root-authoritative evidence indexes ignore regex literals after declaration blocks", () => {
  const evidence = authoritativeEvidenceIndex(
    [
      "function completedFunction() {}",
      "/export function forgedAfterFunction() {}/.test(input);",
      "class CompletedClass {}",
      "/export function forgedAfterClass() {}/.test(input);",
      "if (enabled) {} else {}",
      "/export function forgedAfterElse() {}/.test(input);",
      "try {} catch {}",
      "/export function forgedAfterOptionalCatch() {}/.test(input);",
      "try {} finally {}",
      "/export function forgedAfterFinally() {}/.test(input);",
      "{ const blockScoped = true; }",
      "/export function forgedAfterBareBlock() {}/.test(input);",
      "export function verifiedAnchor() {}",
      ""
    ].join("\n"),
    "plugins/better-workflows/scripts/lib/candidate.mjs"
  );
  assert.deepEqual(evidence.exportedSymbols, ["verifiedAnchor"]);
  assert.equal(evidence.namedSymbols.includes("forgedAfterFunction"), false);
  assert.equal(evidence.namedSymbols.includes("forgedAfterClass"), false);
  assert.equal(evidence.namedSymbols.includes("forgedAfterElse"), false);
  assert.equal(evidence.namedSymbols.includes("forgedAfterOptionalCatch"), false);
  assert.equal(evidence.namedSymbols.includes("forgedAfterFinally"), false);
  assert.equal(evidence.namedSymbols.includes("forgedAfterBareBlock"), false);
});

test("root signer validates the repository standing-consent policy without sanitizer drift", async () => {
  const policy = JSON.parse(await readFile(STANDING_CONSENT_POLICY, "utf8"));
  assert.deepEqual(validateStandingConsentPolicy(policy), policy);
  assert.equal(policy.sanitization.allowedPathPatterns.some((pattern) => pattern.includes("webp")), false);
  assert.throws(
    () => validateStandingConsentPolicy({
      ...policy,
      sanitization: { ...policy.sanitization, secretPattern: "a^" }
    }),
    /sanitization policy is invalid/
  );
  assert.throws(
    () => validateStandingConsentPolicy({
      ...policy,
      sanitization: { ...policy.sanitization, allowedPathPatterns: ["^.*$"] }
    }),
    /sanitization policy is invalid/
  );
});

test("host readiness proves the installed private key matches the trust-root public key", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const trust = {
    value: {
      issuer: "better-workflows-local-host",
      publicKeys: [{
        keyId: "codex-ed25519-test",
        algorithm: "ed25519",
        publicKey: publicKeyDer.toString("base64")
      }]
    },
    digest: createHash("sha256").update("trust-root").digest("hex")
  };
  const proof = await validateSigningKeyPair(trust, seed);
  assert.equal(proof.verified, true);
  assert.equal(proof.proof.keyId, "codex-ed25519-test");
  await assert.rejects(
    () => validateSigningKeyPair(trust, Buffer.alloc(32, 7)),
    /does not match the trust root public key/
  );
});

test("host trust helper fixes authority paths and does not accept environment path overrides", async () => {
  const source = await readFile(SCRIPT, "utf8");
  assert.match(source, /const HOST_ETC = process\.platform === "darwin" \? "\/private\/etc" : "\/etc"/);
  assert.match(source, /`\$\{HOST_ETC\}\/better-workflows\/codex-trust-root\.json`/);
  assert.match(source, /"\/private\/var\/db\/better-workflows\/codex-attestation-ed25519\.raw"/);
  assert.match(source, /Refusing implicit rotation or overwrite/);
  assert.match(source, /execute-result/);
  assert.match(source, /execute-batch/);
  assert.match(source, /execution-ledger/);
  assert.match(source, /requireInstalledCapability/);
  assert.match(source, /spawnCapture/);
  assert.match(source, /detached: true/);
  assert.match(source, /killFn\(-child\.pid/);
  assert.match(source, /DIRECT_CAPTURE_SUPERVISOR_SOURCE/);
  assert.match(source, /stable process-group/);
  assert.match(source, /processGroupIsAlive\(child\.pid, killFn\)\) return false/);
  assert.match(source, /waitForProcessGroupExit/);
  assert.match(source, /groupTerminated/);
  assert.doesNotMatch(source, /function signResultRequest/);
  assert.match(source, /HOST_SIGNER_VERSION/);
  assert.match(source, /signer-upgrade/);
  assert.match(source, /responseDigest/);
  assert.match(source, /trustRootDigest/);
  assert.doesNotMatch(source, /BW_(?:TRUST|PRIVATE|ATTESTATION)/);
  assert.match(source, /command === "capabilities"/);
  assert.match(source, /uid: request\.uid/);
  assert.match(source, /binaryDigest/);
  assert.match(source, /outputExceeded/);
  assert.match(source, /\/private\/var\/db\/better-workflows\/execution-bundles/);
  assert.match(source, /validateRootOwnedDirectory/);
  assert.match(source, /EXECUTION_LAUNCHER/);
  assert.match(source, /requireTrustedRuntime/);
  assert.match(source, /requestDigest/);
  assert.match(source, /runAs/);
  assert.match(source, /SAFETY_REMEDIATION_POLICY_PATH/);
  assert.match(source, /self-improve-safety-remediation-v1\.json/);
  assert.match(source, /SAFETY_REMEDIATION_POLICY_VERSION/);
  assert.match(source, /QUALITY_REMEDIATION_POLICY_PATH/);
  assert.match(source, /self-improve-quality-remediation-v1\.json/);
  assert.match(source, /QUALITY_REMEDIATION_POLICY_VERSION/);
  assert.match(source, /HOST_SIGNER_VERSION = "2\.5\.0"/);
  assert.match(source, /"--strict-config"/);
  assert.match(source, /EVALUATOR_DISABLED_FEATURES\.flatMap\(\(feature\) => \["--disable", feature\]\)/);
  assert.match(source, /EVALUATOR_DISABLED_TOOL_CONFIGS\.flatMap\(\(config\) => \["-c", config\]\)/);
  assert.match(source, /"--no-replace-objects"/);
  assert.match(source, /GIT_NO_REPLACE_OBJECTS: "1"/);
  assert.match(source, /GIT_GRAFT_FILE: "\/dev\/null"/);
  assert.match(source, /rejects legacy Git graft ancestry metadata/);
  assert.match(source, /rejects shallow or indeterminate Git ancestry/);
  assert.match(source, /authoritativeLocalGitValues\(configured, "core\.worktree"\)/);
  assert.match(source, /return authoritativeLocalGitValues\(result, key\)/);
  assert.match(source, /optionalAuthoritativeGitOutput\(headRefResult/);
  assert.match(source, /const entry = await authoritativeTreeEntry\(repo, subject, baselineRevision, file\.path\)/);
  assert.match(source, /authoritativeBlobAtRevision\(repo, subject, revision, relative\)/);
  assert.match(source, /\["cat-file", "blob", entry\.object\]/);
  assert.doesNotMatch(source, /if \(!result\.ok\) \{\s*baselineFiles\.push/);
  assert.doesNotMatch(source, /if \(\(await baselineBlob[^\n]+\)\.ok\)/);
  assert.match(source, /parseEvaluatorTranscript\(result\.stdout\)/);
  assert.match(source, /transcriptPolicy: "codex-jsonl-zero-tool-calls-v1"/);
  assert.match(source, /startEvaluatorRequestGate/);
  assert.match(source, /canonical-root-request-with-explicit-empty-registry/);
  assert.match(source, /supports_websockets=false/);
  assert.match(source, /root-owned-tool-free-model-catalog-v1/);
  assert.match(source, /modelCatalogDigest/);
  assert.match(source, /const policyModel = internalProbe \? EVALUATOR_MODEL : request\.model/);
  assert.match(source, /writeEvaluatorModelCatalog\(modelCatalogPath, policyModel\)/);
  assert.match(source, /modelCompHash: EVALUATOR_MODEL_COMP_HASH/);
  assert.match(source, /comp_hash: EVALUATOR_MODEL_COMP_HASH/);
  assert.match(source, /model_catalog_json=/);
  assert.match(source, /Evaluator request gate exceeded its/);
  assert.match(source, /upstreamRequests/);
  for (const feature of [
    "apps", "collaboration_modes", "computer_use", "deferred_tool_world_state", "js_repl_tools_only",
    "memories", "multi_agent", "multi_agent_mode", "network_proxy", "non_prefixed_mcp_tool_names",
    "plugins", "shell_tool", "tool_search", "unavailable_dummy_tools", "unified_exec", "web_search_request"
  ]) {
    assert.match(source, new RegExp(`"${feature}"`));
  }
  assert.match(source, /standing-consent-admin/);
  assert.match(source, /standing-consent-execution/);
  assert.match(source, /STANDING_CONSENT_AUTHORITY_STATEMENT_DIGEST/);
  assert.match(source, /Standing-consent embedded policy source is not canonical or digest-bound/);
  assert.doesNotMatch(source, /readSourceFile\(request\.policyPath/);
  assert.match(source, /execute-consented-batch/);
  assert.match(source, /validatedManifestBytes/);
  assert.match(source, /validatedRequests/);
  assert.match(source, /suppliedRequestBytes/);
  assert.match(source, /suppliedPromptBytes/);
  assert.match(source, /schemaVersion 5 standing authorization requires execute-consented-batch/);
  assert.match(source, /Standing-authorized execution requests require execute-consented-batch/);
  assert.match(source, /validateConsentedPrompt/);
  assert.match(source, /reconstructStandingBatch/);
  assert.match(source, /validateAuthoritativeStandingManifestBindings/);
  assert.match(source, /validateAuthoritativeStandingRequestBindings/);
  assert.match(source, /"-C", canonicalRepo/);
  assert.match(source, /cwd: canonicalRepo/);
  assert.match(source, /NOPASSWD:NOSETENV: sha256:/);
  assert.match(source, /maxOutputBytes = MAX_OUTPUT_BYTES/);
  assert.match(source, /runReadinessProbe/);
  assert.match(source, /const evaluatorPolicyProbe = await runEvaluatorPolicyProbe/);
  assert.match(source, /const featureArgs = evaluatorFeatureProbeArgs\(\)/);
  assert.match(source, /validateEvaluatorFeatureProbeOutput\(featureResult\.stdout\)/);
  assert.match(source, /const toolTranscript = parseEvaluatorTranscript\(toolResult\.stdout\)/);
  assert.match(source, /featureArgumentsDigest/);
  assert.match(source, /evaluatorPolicy: evaluatorPolicyProbe/);
  assert.match(source, /chmod\(bundle, 0o755\)/);
  assert.match(source, /validateRootOwnedDirectory\(bundle, "Host execution bundle", 0o755\)/);
  assert.match(source, /compileNativeArtifact/);
  assert.match(source, /NATIVE_COMPILER/);
  assert.match(source, /isMachO/);
  assert.match(source, /CODEX_ALLOWLIST/);
  assert.match(source, /READINESS_RECEIPT/);
  assert.match(source, /HOST_BUNDLE_MANIFEST/);
  assert.match(source, /createHostBundleManifest/);
  assert.match(source, /ignoreHostBundle/);
  assert.match(source, /better-workflows-host-bundle/);
  assert.match(source, /supportedConsentSchemas/);
  assert.match(source, /host-readiness-receipt/);
  assert.match(source, /requireReadinessReceipt = true/);
  assert.match(source, /allowUnprovenReadiness/);
  assert.match(source, /requireApprovedCodexBinary/);
  assert.match(source, /approvedCodexAllowlistSource/);
  assert.match(source, /binaryApprovalDigest/);
  assert.match(source, /native Mach-O executable/);
  assert.match(source, /stale backup/);
  assert.match(source, /discardRollbackBackup/);
  assert.match(source, /fixed host runtime root/);
  assert.match(source, /--codex-binary/);
  assert.match(source, /currentRuntime\(manifest\.runtimePath\)/);
  assert.match(source, /validateManifestRunAs/);
  assert.match(source, /validateProtectedDirectoryChain/);
  assert.match(source, /validateProtectedParentChain/);
  assert.match(source, /secureDirectory\(ATTESTATIONS, 0o755\)/);
  assert.match(source, /secureDirectory\(EXECUTIONS, 0o755\)/);
  assert.match(source, /secureDirectory\(EXECUTION_BUNDLES, 0o755\)/);
  assert.match(source, /requestDigests/);
  assert.doesNotMatch(source, /os\.tmpdir\(\)/);
  assert.doesNotMatch(source, /"TMPDIR"|"TEMP"|"TMP"|"HTTP_PROXY"|"HTTPS_PROXY"|"SSL_CERT_FILE"/);
  const launcher = await readFile(path.join(path.dirname(SCRIPT), "host-exec-launcher.c"), "utf8");
  assert.match(launcher, /setgroups\(0, NULL\)/);
  assert.ok(launcher.indexOf("setgid(gid)") < launcher.indexOf("setgroups(0, NULL)"));
  assert.ok(launcher.indexOf("setgroups(0, NULL)") < launcher.indexOf("setuid(uid)"));
  assert.match(launcher, /defined\(__APPLE__\)/);
  assert.match(launcher, /getpwuid/);
  assert.match(launcher, /getgroups\(0, NULL\)/);
  assert.match(launcher, /argc - 8/);
  assert.doesNotMatch(launcher, /argc == 10/);
  assert.match(launcher, /fork\(\)/);
  assert.match(launcher, /setpgid\(0, 0\)/);
  assert.match(launcher, /waitpid\(/);
  assert.match(launcher, /worker_group_pid/);
  assert.match(launcher, /hold_keeper/);
  assert.match(launcher, /pipe\(/);
  assert.match(launcher, /O_NONBLOCK/);
  assert.match(launcher, /stop_worker_group/);
  assert.match(launcher, /forward_stop_signal/);
  assert.match(launcher, /SIGQUIT/);
  assert.match(launcher, /getppid\(\)/);
  assert.match(launcher, /kill\(0, SIGKILL\)/);
  assert.match(launcher, /parent-death watchdog/);
  assert.match(launcher, /sigprocmask\(SIG_BLOCK/);
  assert.match(launcher, /sigprocmask\(SIG_UNBLOCK/);
  assert.match(launcher, /sigaddset\(&blocked_signals, SIGTERM/);
  assert.match(launcher, /execve\(/);
  assert.match(launcher, /root-owned 0755/);
  const probe = await readFile(path.join(path.dirname(SCRIPT), "host-execution-probe.c"), "utf8");
  assert.match(probe, /getuid/);
  assert.match(probe, /getgroups/);
  assert.match(probe, /defined\(__APPLE__\)/);
  assert.match(probe, /environment/);
  assert.match(probe, /argv0/);
});

test("installed host signer remains a self-contained single-file capability reporter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bw-host-signer-standalone-"));
  try {
    const standalone = path.join(await realpath(root), "bw-host-trust.mjs");
    await writeFile(standalone, await readFile(SCRIPT));
    const { stdout } = await execFileAsync(process.execPath, [standalone, "capabilities"], { cwd: root });
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.kind, "host-signer-capabilities");
    assert.equal(report.version, "2.5.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("root standing reconstruction reads candidate authority from bound commit objects", async () => {
  const source = await readFile(SCRIPT, "utf8");
  const candidateStart = source.indexOf("async function reconstructCandidateSnapshots");
  const candidateEnd = source.indexOf("async function reconstructCommittedPluginBundleDigest", candidateStart);
  const candidateBlock = source.slice(candidateStart, candidateEnd);
  assert.match(candidateBlock, /"diff-tree"/);
  assert.match(candidateBlock, /baselineRevision, headRevision/);
  assert.match(candidateBlock, /authoritativeGitBytes\(repo, subject, \["cat-file", "blob", entry\.object\]\)/);
  assert.doesNotMatch(candidateBlock, /await (?:lstat|readFile|realpath)\(/);

  const materialStart = source.indexOf("async function reconstructSanitizedMaterial");
  const materialEnd = source.indexOf("const UNTRUSTED_PROMPT_BOUNDARY_MARKERS", materialStart);
  const materialBlock = source.slice(materialStart, materialEnd);
  assert.match(materialBlock, /authoritativeSnapshotBlob\(repo, subject, revision, file\)/);
  assert.match(materialBlock, /redactOwnerTokenDisplayWithPolicy/);
  assert.match(source, /OWNER_TOKEN_UNQUOTED_LITERAL_PATTERN/);
  assert.match(source, /OWNER_TOKEN_SAFE_QUOTED_LITERALS/);
  assert.match(source, /quotedValue !== "\[redacted-owner-token\]"/);
  assert.match(source, /function ownerTokenSecretScanText\(text\)/);
  assert.match(materialBlock, /secretPattern\.test\(ownerTokenSecretScanText\(text\)\)/);
  assert.match(materialBlock, /secretPattern\.test\(ownerTokenSecretScanText\(sanitized\)\)/);
  const executableMaterialIndex = materialBlock.indexOf("const executableMaterial =");
  const executableOwnerTokenValidationIndex = materialBlock.indexOf("assertSafeOwnerTokenExpressions(text, file.path", executableMaterialIndex);
  const executableSanitizationIndex = materialBlock.indexOf("let sanitized = text;", executableMaterialIndex);
  assert.ok(executableOwnerTokenValidationIndex > executableMaterialIndex);
  assert.ok(executableOwnerTokenValidationIndex < executableSanitizationIndex);
  assert.doesNotMatch(materialBlock, /\["show"/);
  assert.doesNotMatch(materialBlock, /readFile\(path\.resolve\(repo/);

  const suiteStart = source.indexOf("async function authoritativeSuiteState");
  const suiteEnd = source.indexOf("function authoritativeCases", suiteStart);
  const suiteBlock = source.slice(suiteStart, suiteEnd);
  assert.match(suiteBlock, /authoritativeBlobAtRevision\(repo, subject, headRevision, expectedSourcePath\)/);
  assert.doesNotMatch(suiteBlock, /\["show"/);
  assert.doesNotMatch(suiteBlock, /readFile\(path\.resolve\(repo/);

  const blobStart = source.indexOf("export async function authoritativeBlobAtRevisionFromGit");
  const blobEnd = source.indexOf("async function authoritativeBlobAtRevision(", blobStart);
  const blobBlock = source.slice(blobStart, blobEnd);
  assert.match(blobBlock, /authoritativeTreeEntryFromGit\(runGit/);
  assert.match(blobBlock, /\["cat-file", "blob", entry\.object\]/);
});

test("host parent-chain validation rejects a user-owned parent around a regular leaf", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "better-workflows-parent-chain."));
  const leaf = path.join(root, "root-owned-shaped-leaf");
  try {
    await writeFile(leaf, "leaf");
    await assert.rejects(
      () => validateProtectedParentChain(leaf, "adversarial host artifact"),
      /unsafe parent directory|must already be canonical/
    );
    await assert.rejects(
      () => validateProtectedDirectoryChain(root, "adversarial host root"),
      /unsafe parent directory|must already be canonical/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host process-group teardown refuses a recycled PGID when the stable leader is gone", () => {
  const pid = 424242;
  const calls = [];
  const probe = (target, signal) => {
    calls.push([target, signal]);
    if (target === pid) {
      const error = new Error("leader is gone");
      error.code = "ESRCH";
      throw error;
    }
    return undefined;
  };
  assert.equal(terminateProcessGroupForTest(pid, "SIGTERM", probe), false);
  assert.deepEqual(calls, [[pid, 0]]);
});

test("host capture waits for SIGKILL escalation after output overflow", async () => {
  const result = await spawnCapture(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(3 * 1024 * 1024)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
  ], { timeoutMs: 10_000 });
  assert.equal(result.outputExceeded, true);
  assert.equal(result.signal, "SIGKILL");
});

test("host capture honors a caller-specific output limit before SIGKILL escalation", async () => {
  const result = await spawnCapture(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(64 * 1024)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
  ], { timeoutMs: 10_000, maxOutputBytes: 16 * 1024 });
  assert.equal(result.outputExceeded, true);
  assert.ok(["SIGTERM", "SIGKILL"].includes(result.signal));
});

async function assertProcessGone(pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} survived host capture cleanup`);
}

function forkIgnoringSignalScript(pidPath) {
  return [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "const pidPath = process.argv[1];",
    "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 10000);\"], { stdio: 'ignore' });",
    "fs.writeFileSync(pidPath, String(child.pid));",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 10000);"
  ].join(" ");
}

test("host capture timeout terminates forked evaluator descendants", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "better-workflows-process-group-timeout."));
  const pidPath = path.join(root, "descendant.pid");
  try {
    const result = await spawnCapture(process.execPath, ["-e", forkIgnoringSignalScript(pidPath), pidPath], {
      timeoutMs: 100
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.groupTerminated, true);
    const descendantPid = Number((await readFile(pidPath, "utf8")).trim());
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    await assertProcessGone(descendantPid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host capture abort terminates forked readiness-policy descendants", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "better-workflows-process-group-abort."));
  const pidPath = path.join(root, "descendant.pid");
  const controller = new AbortController();
  try {
    const capture = spawnCapture(process.execPath, ["-e", forkIgnoringSignalScript(pidPath), pidPath], {
      timeoutMs: 10_000,
      abortSignal: controller.signal
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const result = await capture;
    assert.equal(result.timedOut, false);
    assert.equal(result.groupTerminated, true);
    const descendantPid = Number((await readFile(pidPath, "utf8")).trim());
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    await assertProcessGone(descendantPid);
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("host evaluator timeout terminates descendants in its process group", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "better-workflows-spawn-group."));
  const pidFile = path.join(root, "descendant.pid");
  const childScript = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });`,
    `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    "setTimeout(() => {}, 10000);"
  ].join("");
  try {
    const result = await spawnCapture(process.execPath, ["-e", childScript], {
      timeoutMs: 300,
      maxOutputBytes: 32 * 1024
    });
    assert.equal(result.timedOut, true);
    const pid = Number(await readFile(pidFile, "utf8"));
    let alive = true;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(alive, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host execution request is a pre-execution contract and cannot carry caller result facts", () => {
  const request = {
    binaryApprovalDigest: "c".repeat(64),
    binaryDigest: "b".repeat(64),
    binaryPath: "/usr/bin/codex",
    codexHomePath: null,
    execution: {
      id: "run-holdout-candidate-1",
      runId: "run-12345678",
      suiteDigest: "suite-12345678",
      baselineRevision: "abcdef1234567890abcdef1234567890abcdef12",
      candidateDigest: "candidate-12345678",
      headRevision: "d".repeat(40),
      promptDigest: "a".repeat(64),
      role: "candidate",
      sourceBindingDigest: "e".repeat(64),
      attempt: 1
    },
    gid: 1000,
    homePath: "/home/test-user",
    model: "gpt-5.6-sol",
    pluginBundleDigest: "f".repeat(64),
    promptDigest: "a".repeat(64),
    promptPath: "/private/tmp/replay.prompt.txt",
    uid: 1000
  };
  assert.deepEqual(validateExecutionRequest(request), request);
  assert.throws(
    () => validateExecutionRequest({ ...request, responseDigest: "b".repeat(64) }),
    /execution request fields/
  );
  assert.throws(
    () => validateExecutionRequest({ ...request, binaryDigest: "not-a-digest" }),
    /binary digest is invalid/
  );
  assert.throws(
    () => validateExecutionRequest({ ...request, finishedAt: new Date().toISOString() }),
    /execution request fields/
  );
  const safetyExecution = {
    ...request.execution,
    purpose: "safety-remediation-v1",
    policyDigest: "1".repeat(64)
  };
  const safetyRequest = {
    ...request,
    execution: safetyExecution,
    purpose: "safety-remediation-v1",
    policyDigest: "1".repeat(64)
  };
  assert.deepEqual(validateExecutionRequest(safetyRequest), safetyRequest);
  assert.throws(
    () => validateExecutionRequest({ ...safetyRequest, policyDigest: "2".repeat(64) }),
    /bindings do not match/
  );
  const qualityRequest = {
    ...request,
    execution: {
      ...request.execution,
      purpose: "quality-remediation-v1",
      policyDigest: "3".repeat(64)
    },
    purpose: "quality-remediation-v1",
    policyDigest: "3".repeat(64)
  };
  assert.deepEqual(validateExecutionRequest(qualityRequest), qualityRequest);
});

test("host validates standing evaluator authorization without broadening the execution contract", () => {
  const authorization = {
    mode: "standing-user-consent",
    grantId: "bw-standing-1000-v1",
    grantDigest: "1".repeat(64),
    policyId: "self-improve-standing-evaluator-consent",
    policyVersion: "v1",
    policyDigest: "2".repeat(64),
    repo: "/private/tmp/better-workflows-repository",
    provider: "codex",
    model: "gpt-5.6-terra",
    purpose: "ordinary",
    requestCount: 7,
    requestRoot: "/private/tmp/better-workflows-standing-consent-1000",
    subject: {
      uid: 1000,
      gid: 1000,
      username: "maintainer",
      homePath: "/home/maintainer",
      codexHomePath: "/home/maintainer/.codex"
    },
    readOnly: true,
    ephemeral: true,
    sanitized: true
  };
  const execution = {
    id: "run-holdout-candidate-1",
    runId: "run-12345678",
    suiteDigest: "suite-12345678",
    baselineRevision: "abcdef1234567890abcdef1234567890abcdef12",
    candidateDigest: "candidate-12345678",
    headRevision: "d".repeat(40),
    promptDigest: "a".repeat(64),
    role: "candidate",
    sourceBindingDigest: "e".repeat(64),
    attempt: 1,
    authorization
  };
  const request = {
    binaryApprovalDigest: "c".repeat(64),
    binaryDigest: "b".repeat(64),
    binaryPath: "/usr/bin/codex",
    codexHomePath: authorization.subject.codexHomePath,
    execution,
    gid: authorization.subject.gid,
    homePath: authorization.subject.homePath,
    model: authorization.model,
    pluginBundleDigest: "f".repeat(64),
    promptDigest: execution.promptDigest,
    promptPath: "/private/tmp/replay.prompt.txt",
    uid: authorization.subject.uid,
    authorization,
    materialBinding: {
      schemaVersion: 1,
      sanitizerPolicyDigest: authorization.policyDigest,
      snapshotDigest: "3".repeat(64),
      files: [{ path: "README.md", state: "missing", digest: null, mode: null, size: null }],
      materialsDigest: "4".repeat(64)
    }
  };
  assert.deepEqual(validateExecutionRequest(request), request);
  assert.throws(
    () => validateExecutionRequest({ ...request, model: "gpt-5.6-sol" }),
    /does not match its execution, model, purpose, or run-as identity/
  );
  assert.throws(
    () => validateExecutionRequest({ ...request, materialBinding: { ...request.materialBinding, sanitizerPolicyDigest: "5".repeat(64) } }),
    /Material binding is invalid/
  );
});

test("macOS visudo accepts the digest-bound standing-consent command regex", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "better-workflows-sudoers."));
  const target = path.join(root, "standing-consent");
  try {
    const rule = standingConsentSudoers({
      grant: {
        subject: { username: os.userInfo().username },
        requestRoot: "/private/tmp/better-workflows-standing-consent-501"
      },
      runtime: {
        path: `/private/var/db/better-workflows/bin/bw-host-node.${"a".repeat(64)}`,
        digest: "a".repeat(64)
      }
    });
    await writeFile(target, rule, { mode: 0o440 });
    const result = await spawnCapture("/usr/sbin/visudo", ["-cf", target], {
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-root consent status can derive sudoers evidence while root rejects content drift", async () => {
  const grant = {
    subject: { username: "maintainer" },
    requestRoot: "/private/tmp/better-workflows-standing-consent-501"
  };
  const runtime = {
    path: `/private/var/db/better-workflows/bin/bw-host-node.${"a".repeat(64)}`,
    digest: "a".repeat(64)
  };
  const expectedBytes = Buffer.from(standingConsentSudoers({ grant, runtime }), "utf8");
  const deferred = await standingConsentSudoersEvidence({ grant, runtime });
  const verified = await standingConsentSudoersEvidence({ grant, runtime, actualBytes: expectedBytes });
  assert.equal(deferred.digest, verified.digest);
  assert.equal(deferred.verification, "deferred-to-root-execution");
  assert.equal(verified.verification, "content-verified");
  await assert.rejects(
    () => standingConsentSudoersEvidence({ grant, runtime, actualBytes: Buffer.from("tampered\n") }),
    /does not match the signed grant/
  );
});
