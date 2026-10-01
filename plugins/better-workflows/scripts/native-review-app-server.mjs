import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createContentSession, readContentSnapshot, readContentStream,
  MAX_REVIEW_IMAGE_BYTES, MAX_BATCH_BYTES, MAX_VISIBLE_OUTPUT_BYTES, VISIBLE_TRANSPORT } from "./lib/native-review-content.mjs";
import { APP_SERVER_LINE_BYTES, boundedJsonl, createImageInputPolicy } from "./lib/native-review-transport.mjs";
import { readPinnedGitObject } from "./lib/native-review-git.mjs";
import { requireSupportedCodexVersion } from "./lib/native-review-version.mjs";

// Keep the app-server history limit aligned with the conservative page budget;
// a larger setting allows a valid transport frame to exceed model context
// headroom before the host can compact it.
const TOOL_OUTPUT_TOKEN_LIMIT = 24 * 1024;
const MAX_OUTPUT_BYTES = MAX_BATCH_BYTES;
const MAX_JOB_BYTES = 8 * 1024 * 1024;
const MAX_PREBOUND_BYTES = 8 * 1024 * 1024;
const MAX_REQUESTS = 10_000;
const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const DISABLED_FEATURES = [
  "apps", "artifact", "auth_elicitation", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
  "code_mode_buffered_exec", "code_mode_host", "collaboration_modes", "computer_use", "deferred_executor",
  "deferred_tool_world_state", "enable_fanout", "enable_mcp_apps", "exec_permission_approvals",
  "executor_capability_discovery", "hooks", "image_generation", "in_app_browser", "js_repl", "js_repl_tools_only",
  "chronicle", "memories", "multi_agent", "multi_agent_mode", "multi_agent_v2", "network_proxy",
  "non_prefixed_mcp_tool_names", "plugins", "remote_plugin", "request_permissions_tool", "shell_snapshot",
  "shell_tool", "skill_search", "standalone_web_search", "tool_call_mcp_elicitation", "tool_search", "tool_suggest",
  "unavailable_dummy_tools", "view_image", "web_search_request", "workspace_dependencies"
];

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys, label) => {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} object required`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `Unbound ${label} field`);
};

async function physicalFile(file, label, maximum = MAX_JOB_BYTES) {
  assert(path.isAbsolute(file) && path.resolve(file) === file, `${label} path must be absolute`);
  assert.equal(await realpath(file), file, `${label} path must be physical`);
  const before = await lstat(file);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maximum,
    `${label} must be one bounded physical file`);
  const bytes = await readFile(file);
  const after = await lstat(file);
  assert(before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && bytes.length === after.size, `${label} changed while read`);
  return { file, bytes, info: after, digest: sha256(bytes) };
}

async function assertUnchanged(original, label) {
  const current = await physicalFile(original.file, label, Math.max(original.bytes.length, 1));
  assert(current.info.dev === original.info.dev && current.info.ino === original.info.ino &&
    current.digest === original.digest && current.bytes.equals(original.bytes), `${label} changed during review`);
}

async function absentPhysicalParent(file) {
  assert(path.isAbsolute(file) && path.resolve(file) === file, "Result path must be absolute");
  await assert.rejects(lstat(file), error => error?.code === "ENOENT", "Result path must be absent");
  const requested = path.dirname(file);
  const parent = await realpath(requested);
  const stableMacAlias = process.platform === "darwin" &&
    ((requested.startsWith("/tmp/") && parent === `/private${requested}`) ||
      (requested.startsWith("/var/") && parent === `/private${requested}`));
  assert(parent === requested || stableMacAlias, "Result parent must be one physical directory");
  const info = await lstat(parent);
  assert(info.isDirectory() && !info.isSymbolicLink(), "Result parent must be a physical directory");
}

async function loadJob(jobPath, expectedDigest) {
  assert(DIGEST.test(expectedDigest), "Exact job SHA-256 required");
  const source = await physicalFile(jobPath, "Native review job");
  assert.equal(source.digest, expectedDigest, "Native review job digest mismatch");
  const job = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes));
  const sharded = Object.hasOwn(job, "shard");
  exact(job, ["schemaVersion", "codex", "cwd", "model", "reasoningEffort", "executionId", "resultPath", "prompt", "content", "images",
    ...(sharded ? ["shard", "context"] : [])], "job");
  assert.equal(job.schemaVersion, 1);
  assert(SAFE_ID.test(job.model) && SAFE_ID.test(job.reasoningEffort), "Exact model and effort required");
  assert(SAFE_ID.test(job.executionId), "Invalid execution identity");
  assert(typeof job.prompt === "string" && Buffer.byteLength(job.prompt) <= MAX_JOB_BYTES, "Invalid bounded prompt");
  exact(job.content, ["indexPath", "indexSha256"], "content binding");
  assert(DIGEST.test(job.content.indexSha256), "Invalid content index digest");
  assert(Array.isArray(job.images) && job.images.length <= 256, "Invalid image list");
  assert(path.isAbsolute(job.cwd) && path.resolve(job.cwd) === job.cwd && await realpath(job.cwd) === job.cwd,
    "Working directory must be physical and absolute");
  const cwdInfo = await lstat(job.cwd);
  assert(cwdInfo.isDirectory() && !cwdInfo.isSymbolicLink(), "Working directory must be a physical directory");
  await absentPhysicalParent(job.resultPath);
  assert(path.isAbsolute(job.codex) && path.resolve(job.codex) === job.codex, "Codex path must be absolute");
  const codex = await realpath(job.codex);
  const codexInfo = await lstat(codex);
  assert(codexInfo.isFile() && !codexInfo.isSymbolicLink() && (codexInfo.mode & 0o111), "Codex target must be executable");
  const { index, directory } = await readContentSnapshot(job.content.indexPath, job.content.indexSha256);
  let contextIndex = index;
  if (sharded) {
    exact(job.shard, ["protocol", "planDigest", "parentIndexSha256", "shardId", "subsetDigest", "phase"], "shard");
    assert.equal(job.shard.protocol, "native-review-sharded-v1");
    assert([job.shard.planDigest, job.shard.parentIndexSha256, job.shard.subsetDigest].every(v => DIGEST.test(v)));
    assert(SAFE_ID.test(job.shard.shardId) && ["shard", "cross-module"].includes(job.shard.phase));
    exact(job.context, ["indexPath", "indexSha256"], "context binding");
    assert.equal(job.context.indexSha256, job.shard.parentIndexSha256);
    contextIndex = (await readContentSnapshot(job.context.indexPath, job.context.indexSha256)).index;
    const parent = contextIndex.streams[0].binding;
    for (const stream of index.streams) {
      assert(["base", "head", "packageSha256", "manifestSha256"].every(k => stream.binding[k] === parent[k]),
        "Shard source does not match parent context");
      const original = contextIndex.streams.find(s => s.id === stream.id);
      if (original) assert.deepEqual(stream, original, "Shard changes a parent stream");
      else assert(job.shard.phase === "cross-module" && /^__bw_review_reports__\/shard-[0-9]{3}\.json$/.test(stream.binding.path),
        "Foreign shard stream");
    }
  }
  const images = [];
  let imageBytes = 0;
  for (const image of job.images) {
    exact(image, ["file", "path", "revision", "sha256", "bytes"], "image binding");
    assert(typeof image.path === "string" && image.path && !path.isAbsolute(image.path) &&
      !image.path.split("/").some(part => ["", ".", ".."].includes(part)), "Invalid image source path");
    assert(typeof image.revision === "string" && image.revision.length > 0 && image.revision.length <= 128,
      "Invalid image revision");
    assert(DIGEST.test(image.sha256), "Invalid image digest");
    assert(Number.isSafeInteger(image.bytes) && image.bytes >= 0 && image.bytes <= 8 * 1024 * 1024,
      "Invalid image byte count");
    assert(index.streams.some(stream => stream.binding.path === image.path &&
      [stream.binding.base, stream.binding.head].includes(image.revision)), "Image is outside the frozen manifest");
    imageBytes += image.bytes;
    assert(imageBytes <= MAX_REVIEW_IMAGE_BYTES, "Native review aggregate image budget exceeded");
    const file = await physicalFile(image.file, "Native review image", 8 * 1024 * 1024);
    assert.equal(file.bytes.length, image.bytes, "Native review image byte count mismatch");
    assert.equal(file.digest, image.sha256, "Native review image digest mismatch");
    images.push({ ...image, source: file });
  }
  return { job, source, codex, cwdInfo, index, contextIndex, directory, images };
}

function featureConfig(job, mcpNames = []) {
  const features = Object.fromEntries(DISABLED_FEATURES.map(name => [name, false]));
  Object.assign(features, {
    skip_host_skill_discovery: true,
    unified_exec: true,
    code_mode: { enabled: false, direct_only_tool_namespaces: ["bw_review"] },
    code_mode_only: false
  });
  return {
    model_reasoning_effort: job.reasoningEffort,
    tool_output_token_limit: TOOL_OUTPUT_TOKEN_LIMIT,
    web_search: "disabled",
    // Keep the unified-exec engine available for the host, but disable the
    // model-facing experimental tool.  Native review exposes only the
    // package-bound bw_review namespace; allowing the experimental tool here
    // lets a model emit an unbound custom_tool_call before the transport can
    // reject it, which aborts an otherwise valid shard.
    experimental_use_unified_exec_tool: false,
    // Model-owned CodeModeOnly otherwise overrides the disabled feature flag.
    // These options live under features.code_mode, not a top-level code_mode.
    features,
    mcp_servers: Object.fromEntries(mcpNames.map(name => [name, { enabled: false }]))
  };
}

function cliArgs(job) {
  const config = featureConfig(job);
  const entries = [
    ["model_reasoning_effort", config.model_reasoning_effort],
    ["tool_output_token_limit", config.tool_output_token_limit],
    ["web_search", config.web_search],
    ...Object.entries(config.features).flatMap(([name, value]) => name === "code_mode"
      ? Object.entries(value).map(([key, setting]) => [`features.code_mode.${key}`, setting])
      : [[`features.${name}`, value]]),
    ["tools.web_search", false],
    ["tools.experimental_request_user_input.enabled", false],
    ["tools.update_plan.enabled", false],
    ["orchestrator.skills.enabled", false],
    ["experimental_use_unified_exec_tool", config.experimental_use_unified_exec_tool]
  ];
  return [...entries.flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]), "app-server", "--stdio"];
}

function verifyEffectiveConfig(result, job) {
  const config = result?.config;
  assert.equal(config?.model_reasoning_effort, job.reasoningEffort, "Native review effort is not pinned");
  assert.equal(config?.tool_output_token_limit, TOOL_OUTPUT_TOKEN_LIMIT, "Tool-output history limit is not pinned");
  assert.equal(config?.web_search, "disabled", "Web search is not disabled");
  assert.equal(config?.experimental_use_unified_exec_tool, false,
    "Experimental unified-exec tool is not disabled");
  // Verify the typed effective feature config as well as the raw session layer
  // and winning leaf origin. An unknown top-level key can exist in a raw layer
  // while having no effect on the actual tool router.
  const layers = result?.layers?.filter(layer => layer.name?.type === "sessionFlags" && !layer.disabledReason);
  assert(layers?.length === 1 && typeof layers[0].version === "string", "Missing direct-tool session layer");
  assert.deepEqual(config?.features?.code_mode?.direct_only_tool_namespaces, ["bw_review"],
    "Direct review tool exposure is not effective");
  assert.deepEqual(layers[0].config?.features?.code_mode?.direct_only_tool_namespaces, ["bw_review"],
    "Direct review tool exposure is not pinned");
  assert.equal(layers[0].config?.experimental_use_unified_exec_tool, false,
    "Experimental unified-exec tool is not pinned");
  const origins = Object.entries(result?.origins ?? {}).filter(([key]) =>
    key === "features.code_mode.direct_only_tool_namespaces" || key.startsWith("features.code_mode.direct_only_tool_namespaces."));
  assert(origins.length === 1 && origins[0][0] === "features.code_mode.direct_only_tool_namespaces.0" &&
    origins[0][1]?.name?.type === "sessionFlags" && origins[0][1]?.version === layers[0].version,
    "Direct review tool exposure has a different effective origin");
  for (const name of DISABLED_FEATURES) assert.equal(config?.features?.[name], false, `Feature ${name} is not disabled`);
  assert.equal(config?.features?.skip_host_skill_discovery, true, "Host skill discovery is not disabled");
  assert.equal(config?.features?.unified_exec, true, "Unified exec engine state is not pinned");
  assert.equal(config?.features?.code_mode?.enabled, false, "Code mode is not disabled");
  assert.equal(config?.features?.code_mode_only, false, "Code-mode-only is not disabled");
}

function verifyThread(result, job, codexVersion) {
  assert(result?.thread?.id && result.thread.cliVersion === codexVersion, "Unsupported app-server thread version");
  assert.equal(result.model, job.model, "App-server substituted the requested model");
  assert.equal(result.thread.model, job.model, "Thread model is not pinned");
  assert.equal(result.reasoningEffort, job.reasoningEffort, "App-server substituted the requested effort");
  assert.equal(result.thread.reasoningEffort, job.reasoningEffort, "Thread effort is not pinned");
  assert.equal(result.approvalPolicy, "never", "Thread approvals are not disabled");
  assert.equal(result.cwd, job.cwd);
  assert.equal(result.thread.cwd, job.cwd);
  assert.equal(result.thread.ephemeral, true, "Native review thread is not ephemeral");
  assert(result.sandbox?.type === "readOnly" && result.sandbox.networkAccess !== true,
    "Native review thread is not read-only with network disabled");
}

function verifyMcpPage(page) {
  assert(Array.isArray(page?.data) && (page.nextCursor === null || page.nextCursor === undefined ||
    typeof page.nextCursor === "string"), "Invalid MCP inventory response");
  for (const entry of page.data) {
    const tools = entry?.tools && typeof entry.tools === "object" && !Array.isArray(entry.tools) ? Object.keys(entry.tools) : null;
    const resources = Array.isArray(entry?.resources) ? entry.resources : null;
    const templates = Array.isArray(entry?.resourceTemplates) ? entry.resourceTemplates : null;
    const prompts = entry?.prompts === undefined ? [] : Array.isArray(entry.prompts) ? entry.prompts : null;
    assert(entry?.runtimeStatus === "disabled" && tools?.length === 0 && resources?.length === 0 &&
      templates?.length === 0 && prompts?.length === 0, `Live external MCP capability: ${entry?.name ?? "unknown"}`);
  }
}

function finalText(message, threadId, turnId) {
  if (message.method !== "item/completed" || message.params?.threadId !== threadId ||
      message.params?.turnId !== turnId) return null;
  const item = message.params.item;
  return item?.type === "agentMessage" && item.phase === "final_answer" && typeof item.text === "string" ? item.text : null;
}

let child;
let childClosed;
let bound = false;
let failed = null;
let ownerId = null;
let threadId;
let turnId;
let finalAnswer = null;
let requestCount = 0;
let bufferedBytes = 0;
const buffered = [];
const pending = new Map();
let nextId = 0;
let finishTerminal;
let terminalDone = false;
const terminal = new Promise(resolve => { finishTerminal = resolve; });

function diagnostic(type, values = {}) {
  process.stderr.write(`${JSON.stringify({ type, ...values })}\n`);
}

function fail(error) {
  if (failed) return;
  failed = error instanceof Error ? error : new Error(String(error));
  for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(failed); }
  pending.clear();
  terminalDone = true;
  finishTerminal({ error: failed });
}

function completeTerminal(value) {
  if (terminalDone) return;
  terminalDone = true;
  finishTerminal(value);
}

function stdoutLine(line, maximum = APP_SERVER_LINE_BYTES) {
  assert(Buffer.byteLength(line) <= maximum, "App-server JSONL line exceeds transport limit");
  process.stdout.write(`${line}\n`);
}

function forward(line, maximum = APP_SERVER_LINE_BYTES) {
  if (bound) return stdoutLine(line, maximum);
  bufferedBytes += Buffer.byteLength(line) + 1;
  assert(bufferedBytes <= MAX_PREBOUND_BYTES, "Preflight notifications exceed transport limit");
  buffered.push(line);
}

function send(value) {
  assert(child?.stdin?.writable, "App-server input is closed");
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function rpc(method, params) {
  assert(++requestCount <= MAX_REQUESTS, "App-server request budget exhausted");
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`App-server request timed out: ${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}

function contextPath(value) {
  assert(typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0") &&
    !path.isAbsolute(value), "Context path must be repository-relative");
  const parts = value.split("/");
  assert(!parts.some(part => ["", ".", "..", ".git"].includes(part)), "Context path escapes the repository object");
  return value;
}

async function gitObject(job, revision, relative) {
  return readPinnedGitObject({ cwd: job.cwd, revision, relative, executionId: job.executionId, diagnostic });
}

async function emitContext(job, revisions, allowedPaths, args) {
  exact(args, ["path", "revision", "offset"], "context tool arguments");
  const relative = contextPath(args.path);
  assert(allowedPaths.has(relative), "Context path is outside the frozen manifest");
  assert(["base", "head"].includes(args.revision) && Number.isSafeInteger(args.offset) && args.offset >= 0,
    "Invalid context revision or offset");
  const bytes = await gitObject(job, revisions[args.revision], relative);
  if (bytes === null) return JSON.stringify({ path: relative, revision: args.revision, exists: false,
    blobSha256: null, start: 0, end: 0, eof: true, nextOffset: null, content: "" });
  assert(args.offset <= bytes.length && (args.offset === bytes.length || (bytes[args.offset] & 0xc0) !== 0x80),
    "Context offset is outside a UTF-8 boundary");
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let end = Math.min(bytes.length, args.offset + 32 * 1024);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  let output;
  do {
    const eof = end === bytes.length;
    output = JSON.stringify({ path: relative, revision: args.revision, exists: true, blobSha256: sha256(bytes), start: args.offset,
      end, eof, nextOffset: eof ? null : end,
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(args.offset, end)) });
    if (Buffer.byteLength(output) <= MAX_OUTPUT_BYTES) break;
    end = args.offset + Math.floor((end - args.offset) / 2);
    while (end > args.offset && (bytes[end] & 0xc0) === 0x80) end--;
  } while (end > args.offset);
  assert(Buffer.byteLength(output) <= MAX_OUTPUT_BYTES, "One UTF-8 context unit exceeds the output budget");
  return output;
}

function recoverableContextDenial(error) {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "Context path must be repository-relative",
    "Context path escapes the repository object",
    "Context path is outside the frozen manifest",
    "Invalid context revision or offset",
    "Context offset is outside a UTF-8 boundary"
  ].includes(message);
}

function contextDenialOutput(error) {
  return JSON.stringify({
    protocol: "native-review-context-denied-v1",
    ok: false,
    reason: error instanceof Error ? error.message : String(error)
  });
}

async function main() {
  const [jobPath, jobDigest, ...extra] = process.argv.slice(2);
  assert(extra.length === 0 && jobPath, "Usage: native-review-app-server.mjs JOB_PATH JOB_SHA256");
  const loaded = await loadJob(jobPath, jobDigest);
  const { job, index, directory } = loaded;
  const imageInputPolicy = createImageInputPolicy(job);
  let inputStarted = false;
  let observedTurnId = null;
  ownerId = job.executionId;
  const contentSession = createContentSession(index.streams, job.content.indexSha256,
    stream => readContentStream(directory, stream));
  let toolCalls = 0;
  let contextCalls = 0;
  const revisions = { base: index.streams[0].binding.base, head: index.streams[0].binding.head };
  const allowedPaths = new Set(loaded.contextIndex.streams.map(stream => stream.binding.path));
  assert(index.streams.every(stream => stream.binding.base === revisions.base && stream.binding.head === revisions.head),
    "Content index mixes Git revisions");

  child = spawn(loaded.codex, cliArgs(job), { cwd: job.cwd, stdio: ["pipe", "pipe", "pipe"] });
  diagnostic("bw.app_server.child", {
    owner: job.executionId, pid: process.pid, ppid: process.ppid, childPid: child.pid, cwd: job.cwd,
    ports: [], sockets: [], detached: false
  });
  let stderrBytes = 0;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > MAX_PREBOUND_BYTES) return fail(new Error("App-server stderr exceeds limit"));
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) diagnostic("bw.app_server.stderr", { line: line.slice(0, 16_384) });
  });
  childClosed = new Promise(resolve => child.once("close", (code, signal) => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error("App-server closed")); }
    pending.clear();
    if (!terminalDone) fail(new Error(`App-server closed before terminal turn: ${code ?? signal}`));
    resolve({ code, signal });
  }));
  child.once("error", fail);

  const handleMessage = async line => {
    let messageType = null;
    try {
      const message = JSON.parse(line);
      messageType = { method: message.method ?? null, itemType: message.params?.item?.type ?? null,
        role: message.params?.item?.role ?? null };
      if (message.method === "turn/started" && inputStarted) {
        assert(message.params?.threadId === threadId && typeof message.params?.turn?.id === "string" &&
          message.params.turn.id && observedTurnId === null, "Unexpected app-server turn start");
        observedTurnId = message.params.turn.id;
        if (turnId) assert.equal(observedTurnId, turnId, "App-server turn identity changed");
      }
      const maximum = imageInputPolicy.validate(line, message, {
        threadId: inputStarted ? threadId : null, turnId: turnId ?? observedTurnId
      });
      if (message.id !== undefined && !message.method) {
        const waiter = pending.get(message.id);
        assert(waiter, "Unexpected app-server response id");
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
        return;
      }
      if (message.id !== undefined) {
        if (message.method !== "item/tool/call" || !bound || message.params?.threadId !== threadId ||
            message.params?.turnId !== turnId || message.params?.namespace !== "bw_review" ||
            !["content", "context"].includes(message.params?.tool)) {
          send({ id: message.id, error: { code: -32600, message: "Only the bound read-only review tools are allowed" } });
          throw new Error(`Rejected app-server request: ${message.method ?? "unknown"}`);
        }
        assert(++requestCount <= MAX_REQUESTS && ++toolCalls <= MAX_REQUESTS, "Dynamic tool request budget exhausted");
        if (message.params.tool === "context") {
          assert(++contextCalls <= 64, "Context request budget exhausted");
          try {
            const output = await emitContext(job, revisions, allowedPaths, message.params.arguments);
            assert(Buffer.byteLength(output) <= MAX_OUTPUT_BYTES && Buffer.byteLength(JSON.stringify(output)) <=
              MAX_VISIBLE_OUTPUT_BYTES, "Context tool output exceeds the fixed visible-history budget");
            send({ id: message.id, result: { contentItems: [{ type: "inputText", text: output }], success: true } });
          } catch (error) {
            // A sharded reviewer may ask for a guessed or stale context name
            // after it has already completed its immutable diff stream.  Keep
            // the manifest boundary fail-closed, but make this optional lookup
            // a normal tool denial so one model mistake does not abort every
            // sibling shard and discard otherwise valid coverage evidence.
            if (!(job.shard && recoverableContextDenial(error))) throw error;
            const output = contextDenialOutput(error);
            assert(Buffer.byteLength(output) <= MAX_OUTPUT_BYTES && Buffer.byteLength(JSON.stringify(output)) <=
              MAX_VISIBLE_OUTPUT_BYTES, "Context denial output exceeds the fixed visible-history budget");
            diagnostic("bw.app_server.context_denied", { owner: job.executionId, reason: error.message });
            send({ id: message.id, result: { contentItems: [{ type: "inputText", text: output }], success: false } });
          }
          return;
        }
        const { output, success } = await contentSession.request(message.params.arguments);
        assert(Buffer.byteLength(output) <= MAX_OUTPUT_BYTES && Buffer.byteLength(JSON.stringify(output)) <=
          MAX_VISIBLE_OUTPUT_BYTES, "Content tool output exceeds the fixed visible-history budget");
        send({ id: message.id, result: { contentItems: [{ type: "inputText", text: output }], success } });
        return;
      }
      if (message.method === "rawResponseItem/completed" &&
          message.params?.threadId === threadId && message.params?.turnId === turnId) {
        const item = message.params.item;
        if (["custom_tool_call", "local_shell_call", "web_search_call"].includes(item?.type) ||
            (item?.type === "function_call" && (item.namespace !== "bw_review" ||
              !["content", "context"].includes(item.name)))) {
          // Retain rejected transport evidence too; dropping the exact event
          // makes namespace/adapter diagnosis indistinguishable from a model
          // attempting a forbidden engine. No tool output or authority follows.
          forward(line);
          throw new Error(`Non-direct or unbound tool call in native review: ${JSON.stringify({
            type: item.type, namespace: item.namespace ?? null, name: item.name ?? null
          })}`);
        }
      }
      forward(line, maximum);
      const answer = finalText(message, threadId, turnId);
      if (answer !== null) {
        assert(finalAnswer === null, "Multiple final native review messages");
        finalAnswer = answer;
      }
      if (message.method === "turn/completed" && message.params?.threadId === threadId &&
          message.params?.turn?.id === turnId) completeTerminal({ turn: message.params.turn });
      if (message.method === "error" && (!message.params?.threadId || message.params.threadId === threadId)) {
        throw new Error(`App-server error notification: ${JSON.stringify(message.params)}`);
      }
    } catch (error) {
      diagnostic("bw.app_server.rejected_frame", { owner: job.executionId, bytes: Buffer.byteLength(line),
        sha256: sha256(line), ...messageType, reason: error.message });
      throw error;
    }
  };
  const messages = (async () => {
    for await (const line of boundedJsonl(child.stdout, () => inputStarted
      ? imageInputPolicy.maxFrameBytes : APP_SERVER_LINE_BYTES)) {
      if (failed) break;
      await handleMessage(line);
    }
  })().catch(fail);

  const initialized = await rpc("initialize", {
    clientInfo: { name: "better-workflows-native-review", version: "1.0.0" },
    capabilities: { experimentalApi: true }
  });
  const codexVersion = requireSupportedCodexVersion(initialized?.userAgent);
  send({ method: "initialized", params: {} });
  const effective = await rpc("config/read", { cwd: job.cwd, includeLayers: true });
  verifyEffectiveConfig(effective, job);
  // Discover supported pairs without replacing the caller's exact selection.
  // Availability does not authorize a fallback or an effort downgrade.
  const modelCursors = new Set(), matchingModels = [];
  let modelCursor = null;
  do {
    assert(!modelCursors.has(modelCursor) && modelCursors.size < 100, "Invalid model inventory pagination");
    modelCursors.add(modelCursor);
    const page = await rpc("model/list", { cursor: modelCursor, limit: 100, includeHidden: true });
    assert(Array.isArray(page?.data) && page.data.length <= 100 &&
      (page.nextCursor == null || typeof page.nextCursor === "string"), "Invalid model inventory");
    matchingModels.push(...page.data.filter(item => item?.model === job.model));
    modelCursor = page.nextCursor ?? null;
  } while (modelCursor !== null);
  assert(matchingModels.length === 1, "Requested native review model is unavailable or ambiguous");
  const modelCapability = matchingModels[0];
  assert(Array.isArray(modelCapability.supportedReasoningEfforts) && modelCapability.supportedReasoningEfforts.some(
    option => option?.reasoningEffort === job.reasoningEffort), "Requested native review effort is unsupported");
  assert(Array.isArray(modelCapability.inputModalities) && modelCapability.inputModalities.includes("text") &&
    (!job.images.length || modelCapability.inputModalities.includes("image")), "Requested model cannot review the bound input types");
  const mcpNames = Object.keys(effective.config.mcp_servers ?? {});
  assert(mcpNames.length <= MAX_REQUESTS && mcpNames.every(name => typeof name === "string" && name.length <= 256),
    "Unbounded MCP configuration inventory");
  const threadConfig = featureConfig(job, mcpNames);
  const thread = await rpc("thread/start", {
    model: job.model,
    modelProvider: "openai",
    allowProviderModelFallback: false,
    cwd: job.cwd,
    ephemeral: true,
    experimentalRawEvents: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    environments: [],
    config: threadConfig,
    developerInstructions: "Use bw_review.content directly with page 0, then the page envelope's nextPage, until eof; acknowledge the final batch digest. While coverage is incomplete, issue only the next content request: do not summarize, explain, deliberate, or call bw_review.context between pages. Reserve analysis for after the final EOF acknowledgement. Never copy or decode the nested machine nextCursor. A BW_CONTENT_RETRY_V2 response delivers no content: submit its exact expected request without advancing. Only a valid page or final acknowledgement resets the two-consecutive-corrections position budget, never compaction or a context read. You may call bw_review.context directly for pinned source context after coverage; it never counts as diff coverage. Do not call other tools, use code mode, use a shell, access the network, or mutate files.",
    dynamicTools: [{
      type: "namespace", name: "bw_review", description: "Exact-bound read-only review content; call these tools directly.",
      tools: [{
      type: "function",
      name: "content",
      description: "Read an immutable review page. First call {page:0,acknowledge:null}; continue with the top page envelope's integer nextPage, never the nested nextCursor. After eof use {page:null,acknowledge:batchDigest}. A RETRY response returns the exact expected request without advancing; at most two consecutive corrections at each position, reset only by a valid page or final acknowledgement. Lifetime corrections remain audited.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["page", "acknowledge"],
        properties: {
          page: { type: ["integer", "null"], minimum: 0 },
          acknowledge: { type: ["string", "null"] }
        }
      },
      deferLoading: false
    }, {
      type: "function",
      name: "context",
      description: "Read one bounded UTF-8 source context page of a frozen manifest path from the pinned base or head Git object. Other paths are forbidden. If the path is absent at that pinned revision, return an explicit exists=false marker. This does not count as changed-content coverage.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "revision", "offset"],
        properties: {
          path: { type: "string" },
          revision: { type: "string", enum: ["base", "head"] },
          offset: { type: "integer", minimum: 0 }
        }
      },
      deferLoading: false
    }]}]
  });
  verifyThread(thread, job, codexVersion);
  threadId = thread.thread.id;
  const seenCursors = new Set();
  let inventoryCursor = null;
  do {
    assert(!seenCursors.has(inventoryCursor), "Cyclic MCP inventory cursor");
    seenCursors.add(inventoryCursor);
    const page = await rpc("mcpServerStatus/list", { threadId, cursor: inventoryCursor, limit: 100, detail: "full" });
    verifyMcpPage(page);
    inventoryCursor = page.nextCursor ?? null;
  } while (inventoryCursor !== null);

  stdoutLine(JSON.stringify({
    type: "bw.transport.bound",
    protocol: VISIBLE_TRANSPORT,
    executionId: job.executionId,
    model: job.model,
    threadId,
    indexSha256: job.content.indexSha256,
    codexVersion,
    reasoningEffort: job.reasoningEffort,
    modelCapabilitySha256: sha256(JSON.stringify(modelCapability)),
    directOnlyNamespaces: ["bw_review"],
    toolOutputTokenLimit: TOOL_OUTPUT_TOKEN_LIMIT,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    readOnly: true,
    ephemeral: true,
    externalToolsDisabled: true,
    ...(job.shard ? { shard: job.shard } : {})
  }));
  bound = true;
  for (const line of buffered) stdoutLine(line);
  buffered.length = 0;

  inputStarted = true;
  const turn = await rpc("turn/start", {
    threadId,
    model: job.model,
    effort: job.reasoningEffort,
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    environments: [],
    input: [
      { type: "text", text: job.prompt, text_elements: [] },
      ...job.images.map(image => ({ type: "localImage", path: image.file, detail: "original" }))
    ]
  });
  turnId = turn.turn.id;
  if (observedTurnId) assert.equal(turnId, observedTurnId, "App-server turn identity changed");
  const outcome = await terminal;
  if (outcome.error) throw outcome.error;
  assert(outcome.turn?.status === "completed" && typeof finalAnswer === "string",
    "Native review ended without a final answer");
  assert(imageInputPolicy.observed, "Native review did not observe every authorized input image");
  stdoutLine(JSON.stringify({ type: "bw.transport.terminal", protocol: VISIBLE_TRANSPORT, threadId,
    turnId, contentEof: contentSession.state.eof, acknowledged: contentSession.state.acknowledged,
    contentCorrections: contentSession.state.corrections, consecutiveContentCorrections: contentSession.state.consecutiveCorrections,
    contentToolCalls: toolCalls - contextCalls, contextToolCalls: contextCalls }));
  await assertUnchanged(loaded.source, "Native review job");
  assert.equal(await realpath(job.cwd), job.cwd, "Working directory changed identity");
  for (const image of loaded.images) await assertUnchanged(image.source, "Native review image");
  await readContentSnapshot(job.content.indexPath, job.content.indexSha256);
  if (job.context) await readContentSnapshot(job.context.indexPath, job.context.indexSha256);
  await absentPhysicalParent(job.resultPath);
  child.stdin.end();
  const exit = await childClosed;
  await messages;
  if (failed) throw failed;
  assert(exit.code === 0 && exit.signal === null, `App-server exit was not clean: ${exit.code ?? exit.signal}`);
  await writeFile(job.resultPath, finalAnswer, { flag: "wx", mode: 0o600 });
  diagnostic("bw.app_server.closed", { owner: job.executionId, childPid: child.pid, code: exit.code, signal: exit.signal });
}

try {
  await main();
} catch (error) {
  fail(error);
  if (bound) stdoutLine(JSON.stringify({
    type: "bw.transport.blocked", protocol: VISIBLE_TRANSPORT, threadId: threadId ?? null,
    turnId: turnId ?? null, reason: error.message
  }));
  diagnostic("bw.app_server.blocked", { owner: ownerId, childPid: child?.pid ?? null, reason: error.message });
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  if (childClosed) await childClosed;
  process.exitCode = 1;
}
