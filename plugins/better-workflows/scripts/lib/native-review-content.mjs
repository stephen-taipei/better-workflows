import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { SUPPORTED_CODEX_VERSIONS } from "./native-review-version.mjs";

// Content observations are not semantic approval. The independent review still
// has to make its own findings, and the ordinary admission/signing gates remain.
export const CONTENT_PROTOCOL = "native-review-content-v1";
export const MAX_CONTENT_BYTES = 8192;
const MAX_FRAME_BYTES = 32 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
// Keep a page large enough to reduce model turns for broad reviews, while
// bounding both the raw tool text and its JSON-escaped visible-history form.
// The latter matters for diffs containing many quotes or backslashes: a raw
// byte limit alone can still exceed the app-server's token-sized history cap.
// A broad review must keep each model turn below the native model's effective
// context headroom. The host injects a substantial system/policy history before
// the first page, so a transport-sized 512 KiB response can be accepted by the
// app-server yet be truncated by the model on the next page. Keep each page at
// 96 KiB (24k visible-history tokens) so several contiguous pages remain
// recoverable before compaction, while retaining the source-bound cursor chain.
export const MAX_BATCH_BYTES = 96 * 1024;
const MAX_BATCH_FRAMES = 64;
export const VISIBLE_TRANSPORT = "codex-app-server-visible-v3";
export const MAX_CONTENT_CORRECTIONS = 2;
const MAX_CONTENT_PAGES = 10000;
// The page envelope wraps the JSON batch as a string, so JSON escaping adds
// bytes beyond the raw batch budget. Reserve enough room for that wrapper and
// its escaping before asking the batcher to fill a page.
const PAGE_ENVELOPE_RESERVE = 8 * 1024;
export const HISTORY_TOKEN_LIMIT = 24 * 1024;
export const MAX_VISIBLE_OUTPUT_BYTES = HISTORY_TOKEN_LIMIT * 4;
export const MAX_REVIEW_PATHS = 4096;
export const MAX_REVIEW_DIFF_BYTES = 64 * 1024 * 1024;
export const MAX_REVIEW_IMAGE_BYTES = 64 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ZERO = "0".repeat(64);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const contentDigest = bytes => createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys) => {
  assert(value && typeof value === "object" && !Array.isArray(value), "Content object required");
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), "Unbound content field");
};
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");

function identity(value) {
  const keys = ["base", "head", "packageSha256", "manifestSha256", "path", "sha256", "bytes"];
  exact(value, keys);
  assert(SHA.test(value.base) && SHA.test(value.head));
  assert(DIGEST.test(value.packageSha256) && DIGEST.test(value.manifestSha256) && DIGEST.test(value.sha256));
  assert(typeof value.path === "string" && value.path && !path.isAbsolute(value.path) &&
    !value.path.includes("\0") && !value.path.split("/").some(part => ["", ".", ".."].includes(part)));
  assert(Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= MAX_STREAM_BYTES);
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

function cursorFor(binding, offset, previousFrameDigest) {
  return encode({ binding: identity(binding), offset, previousFrameDigest });
}

export const initialContentCursor = binding => cursorFor(binding, 0, ZERO);

function cursorValue(cursor, binding) {
  assert(typeof cursor === "string" && /^[A-Za-z0-9_-]+$/.test(cursor) && cursor.length < 8192);
  const value = JSON.parse(decoder.decode(Buffer.from(cursor, "base64url")));
  exact(value, ["binding", "offset", "previousFrameDigest"]);
  assert.equal(encode(value), cursor, "Noncanonical content cursor");
  assert.deepEqual(identity(value.binding), identity(binding), "Stale or cross-path content cursor");
  assert(Number.isSafeInteger(value.offset) && value.offset >= 0 && value.offset <= binding.bytes);
  assert(DIGEST.test(value.previousFrameDigest));
  return value;
}

function boundBytes(bytes, binding) {
  identity(binding);
  assert(Buffer.isBuffer(bytes) && bytes.length === binding.bytes && contentDigest(bytes) === binding.sha256,
    "Content bytes changed from the frozen snapshot");
  assert(!bytes.includes(0), "Binary data is not text coverage");
  decoder.decode(bytes);
}

export function emitContentFrame(bytes, binding, cursor = initialContentCursor(binding), limit = MAX_CONTENT_BYTES) {
  boundBytes(bytes, binding);
  assert(Number.isSafeInteger(limit) && limit >= 4 && limit <= MAX_CONTENT_BYTES);
  const prior = cursorValue(cursor, binding);
  assert(prior.offset === 0 || prior.offset < bytes.length, "Terminal cursor cannot be reread");
  let end = Math.min(bytes.length, prior.offset + limit);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  const content = decoder.decode(bytes.subarray(prior.offset, end));
  const payload = {
    protocol: CONTENT_PROTOCOL, binding: identity(binding), start: prior.offset, end,
    previousFrameDigest: prior.previousFrameDigest, content, eof: end === bytes.length
  };
  const frameDigest = contentDigest(JSON.stringify(payload));
  const body = JSON.stringify({ ...payload, frameDigest,
    nextCursor: payload.eof ? null : cursorFor(binding, end, frameDigest) });
  const frame = `BW_CONTENT_FRAME_V1\n${body}\nBW_CONTENT_END:${contentDigest(body)}\n`;
  assert(Buffer.byteLength(frame) <= MAX_FRAME_BYTES, "Content frame exceeds the transport budget");
  return frame;
}

export function consumeContentFrame(text, bytes, binding, cursor = initialContentCursor(binding)) {
  boundBytes(bytes, binding);
  assert(typeof text === "string" && Buffer.byteLength(text) <= MAX_FRAME_BYTES);
  const match = /^BW_CONTENT_FRAME_V1\n([^\n]+)\nBW_CONTENT_END:([a-f0-9]{64})\n$/.exec(text);
  assert(match, "Content frame/footer incomplete; cursor must not advance");
  assert.equal(contentDigest(match[1]), match[2], "Content frame was truncated or rewritten");
  const frame = JSON.parse(match[1]);
  exact(frame, ["protocol", "binding", "start", "end", "previousFrameDigest", "content", "eof", "frameDigest", "nextCursor"]);
  const prior = cursorValue(cursor, binding);
  assert.equal(frame.protocol, CONTENT_PROTOCOL);
  assert.deepEqual(identity(frame.binding), identity(binding));
  assert.equal(frame.start, prior.offset, "Missing or duplicate content page");
  assert.equal(frame.previousFrameDigest, prior.previousFrameDigest);
  assert(typeof frame.content === "string");
  const delivered = Buffer.from(frame.content);
  assert(delivered.length <= MAX_CONTENT_BYTES && (delivered.length > 0 || bytes.length === 0));
  assert.equal(frame.end, frame.start + delivered.length);
  assert(frame.end <= bytes.length);
  assert(delivered.equals(bytes.subarray(frame.start, frame.end)), "Frame does not contain the bound source bytes");
  assert.equal(frame.eof, frame.end === bytes.length, "False content EOF");
  const { frameDigest, nextCursor, ...payload } = frame;
  assert.equal(frameDigest, contentDigest(JSON.stringify(payload)));
  assert.equal(nextCursor, frame.eof ? null : cursorFor(binding, frame.end, frameDigest));
  return { cursor: nextCursor, deliveredThrough: frame.end, contentComplete: frame.eof, frameDigest,
    semanticReviewAccepted: false };
}

function batchCursor(indexSha256, position = 0, offset = 0, previousFrameDigest = ZERO, previousBatchDigest = ZERO) {
  return encode({ indexSha256, position, offset, previousFrameDigest, previousBatchDigest });
}

export const initialBatchCursor = indexSha256 => batchCursor(indexSha256);

function decodeBatchCursor(cursor, indexSha256, streams) {
  assert(DIGEST.test(indexSha256) && typeof cursor === "string" && cursor.length < 2048 && /^[A-Za-z0-9_-]+$/.test(cursor));
  const value = JSON.parse(decoder.decode(Buffer.from(cursor, "base64url")));
  exact(value, ["indexSha256", "position", "offset", "previousFrameDigest", "previousBatchDigest"]);
  assert.equal(encode(value), cursor);
  assert.equal(value.indexSha256, indexSha256, "Batch cursor belongs to another snapshot");
  assert(Number.isSafeInteger(value.position) && value.position >= 0 && value.position < streams.length);
  assert(Number.isSafeInteger(value.offset) && value.offset >= 0 && value.offset <= streams[value.position].binding.bytes);
  assert(DIGEST.test(value.previousFrameDigest) && DIGEST.test(value.previousBatchDigest));
  return value;
}

function advanceBatch(progress, frame) {
  if (frame.eof) { progress.position++; progress.offset = 0; progress.previousFrameDigest = ZERO; }
  else { progress.offset = frame.end; progress.previousFrameDigest = frame.frameDigest; }
}

function encodedBatch(frames, progress, { indexSha256, startCursor, streamCount }) {
  const payload = { protocol: "native-review-content-batch-v1", indexSha256, startCursor, frames,
    eof: progress.position === streamCount };
  const batchDigest = contentDigest(JSON.stringify(payload));
  const body = JSON.stringify({ ...payload, batchDigest, nextCursor: payload.eof ? null :
    batchCursor(indexSha256, progress.position, progress.offset, progress.previousFrameDigest, batchDigest) });
  return `BW_CONTENT_BATCH_V1\n${body}\nBW_CONTENT_BATCH_END:${contentDigest(body)}\n`;
}

const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));

// Batch small paths together, and large paths in contiguous frames. The bound
// is encoded transport bytes, not a guessed line count. No part of an oversized
// next frame is emitted or credited. Reading a snapshot never persists progress.
export async function emitContentBatch(streams, indexSha256, readBytes, cursor = initialBatchCursor(indexSha256), maximum = MAX_BATCH_BYTES) {
  assert(Number.isSafeInteger(maximum) && maximum >= MAX_FRAME_BYTES && maximum <= MAX_BATCH_BYTES);
  const progress = decodeBatchCursor(cursor, indexSha256, streams);
  const frames = [];
  let output = null;
  while (progress.position < streams.length && frames.length < MAX_BATCH_FRAMES) {
    const stream = streams[progress.position];
    const bytes = await readBytes(stream);
    const frameText = emitContentFrame(bytes, stream.binding,
      cursorFor(stream.binding, progress.offset, progress.previousFrameDigest));
    const frame = JSON.parse(frameText.split("\n")[1]);
    const next = { ...progress };
    advanceBatch(next, frame);
    const candidate = encodedBatch([...frames, { streamId: stream.id, frame }], next,
      { indexSha256, startCursor: cursor, streamCount: streams.length });
    if (Buffer.byteLength(candidate) > maximum || jsonBytes(candidate) > MAX_VISIBLE_OUTPUT_BYTES) break;
    output = candidate;
    frames.push({ streamId: stream.id, frame });
    Object.assign(progress, next);
  }
  assert(output, "A complete content frame cannot fit the batch budget");
  return output;
}

export function consumeContentBatch(text, streams, indexSha256, cursor = initialBatchCursor(indexSha256)) {
  assert(typeof text === "string" && Buffer.byteLength(text) <= MAX_BATCH_BYTES &&
    jsonBytes(text) <= MAX_VISIBLE_OUTPUT_BYTES);
  const match = /^BW_CONTENT_BATCH_V1\n([^\n]+)\nBW_CONTENT_BATCH_END:([a-f0-9]{64})\n$/.exec(text);
  assert(match, "Content batch/footer incomplete; cursor must not advance");
  assert.equal(contentDigest(match[1]), match[2]);
  const batch = JSON.parse(match[1]);
  exact(batch, ["protocol", "indexSha256", "startCursor", "frames", "eof", "batchDigest", "nextCursor"]);
  assert.equal(batch.protocol, "native-review-content-batch-v1");
  assert.equal(batch.indexSha256, indexSha256);
  assert.equal(batch.startCursor, cursor, "Missing or replayed content batch");
  assert(Array.isArray(batch.frames) && batch.frames.length > 0 && batch.frames.length <= MAX_BATCH_FRAMES);
  const progress = decodeBatchCursor(cursor, indexSha256, streams);
  const observations = [];
  for (const entry of batch.frames) {
    exact(entry, ["streamId", "frame"]);
    const stream = streams[progress.position];
    assert(stream && entry.streamId === stream.id, "Missing, duplicated or out-of-order content path");
    const body = JSON.stringify(entry.frame);
    const frame = consumeContentFrame(`BW_CONTENT_FRAME_V1\n${body}\nBW_CONTENT_END:${contentDigest(body)}\n`,
      stream.bytes, stream.binding, cursorFor(stream.binding, progress.offset, progress.previousFrameDigest));
    observations.push({ streamId: stream.id, ...frame });
    advanceBatch(progress, entry.frame);
  }
  assert.equal(batch.eof, progress.position === streams.length);
  assert.equal(text, encodedBatch(batch.frames, progress, { indexSha256, startCursor: cursor, streamCount: streams.length }),
    "Forged batch digest, EOF or next cursor");
  return { observations, cursor: batch.nextCursor, batchDigest: batch.batchDigest,
    contentComplete: batch.eof, semanticReviewAccepted: false };
}

// Page numbers are selectors, never authority. The complete source-bound cursor
// stays on the host; every response still carries the original digest chain.
export async function emitContentPage(streams, indexSha256, readBytes, cursor, page) {
  assert(Number.isSafeInteger(page) && page >= 0 && page < MAX_CONTENT_PAGES, "Invalid content page number");
  const batch = await emitContentBatch(streams, indexSha256, readBytes, cursor, MAX_BATCH_BYTES - PAGE_ENVELOPE_RESERVE);
  const value = JSON.parse(batch.split("\n")[1]);
  const control = { page, nextPage: value.eof ? null : page + 1, eof: value.eof, batchDigest: value.batchDigest };
  const output = `BW_CONTENT_PAGE_V1\n${JSON.stringify(control)}\n${batch}`;
  assert(Buffer.byteLength(output) <= MAX_BATCH_BYTES && jsonBytes(output) <= MAX_VISIBLE_OUTPUT_BYTES);
  return output;
}

export function consumeContentPage(text, streams, indexSha256, cursor, page) {
  assert(typeof text === "string" && Buffer.byteLength(text) <= MAX_BATCH_BYTES &&
    jsonBytes(text) <= MAX_VISIBLE_OUTPUT_BYTES);
  const match = /^BW_CONTENT_PAGE_V1\n([^\n]+)\n([\s\S]+)$/.exec(text);
  assert(match, "Content page envelope is incomplete");
  const control = JSON.parse(match[1]);
  exact(control, ["page", "nextPage", "eof", "batchDigest"]);
  assert.equal(JSON.stringify(control), match[1], "Noncanonical content page envelope");
  assert.equal(control.page, page, "Missing or replayed content page number");
  const result = consumeContentBatch(match[2], streams, indexSha256, cursor);
  assert.equal(control.nextPage, result.contentComplete ? null : page + 1, "Forged next page number");
  assert.equal(control.eof, result.contentComplete, "Forged page EOF");
  assert.equal(control.batchDigest, result.batchDigest, "Forged page batch digest");
  return result;
}

export function contentRequestMatches(args, expected) {
  exact(args, ["page", "acknowledge"]);
  assert(args.page === null || Number.isSafeInteger(args.page), "Content page must be an integer or null");
  assert(args.acknowledge === null || typeof args.acknowledge === "string", "Invalid content acknowledgement type");
  return args.page === expected.page && args.acknowledge === expected.acknowledge;
}

export function contentCorrection(indexSha256, expected, count, total) {
  assert(DIGEST.test(indexSha256));
  assert(Number.isSafeInteger(count) && count > 0 && count <= MAX_CONTENT_CORRECTIONS,
    "Content correction budget exhausted");
  assert(Number.isSafeInteger(total) && total >= count && total <= MAX_CONTENT_CORRECTIONS * (MAX_CONTENT_PAGES + 1),
    "Invalid lifetime content correction count");
  contentRequestMatches(expected, expected);
  return `BW_CONTENT_RETRY_V2\n${JSON.stringify({ protocol: "native-review-content-retry-v2", indexSha256,
    expected, budgetScope: "expected-position", correction: count, totalCorrections: total,
    maximumCorrections: MAX_CONTENT_CORRECTIONS, advanced: false })}\n`;
}

export function createContentSession(streams, indexSha256, readBytes) {
  let cursor = initialBatchCursor(indexSha256), page = 0, eof = false, acknowledged = false;
  let lastBatchDigest = null, corrections = 0, consecutiveCorrections = 0;
  return {
    async request(args) {
      assert(!acknowledged, "Content session is already acknowledged");
      assert(consecutiveCorrections <= MAX_CONTENT_CORRECTIONS, "Content correction budget exhausted");
      const expected = eof ? { page: null, acknowledge: lastBatchDigest } : { page, acknowledge: null };
      if (!contentRequestMatches(args, expected)) {
        // Reject the requested position without delivering bytes or advancing.
        // A bounded correction stays in this execution; it is not a model retry.
        return { output: contentCorrection(indexSha256, expected, ++consecutiveCorrections, ++corrections), success: false };
      }
      if (eof) {
        acknowledged = true;
        consecutiveCorrections = 0;
        return { output: `BW_CONTENT_ACK:${lastBatchDigest}\n`, success: true };
      }
      const output = await emitContentPage(streams, indexSha256, readBytes, cursor, page);
      const batch = JSON.parse(output.split("\n")[3]);
      cursor = batch.nextCursor;
      eof = batch.eof;
      lastBatchDigest = batch.batchDigest;
      page++;
      // Compaction or context reads are not progress. Reset only after a bound
      // page is emitted; lifetime corrections remain an independent audit fact.
      consecutiveCorrections = 0;
      return { output, success: true };
    },
    get state() { return { page, eof, acknowledged, corrections, consecutiveCorrections }; }
  };
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function contentCommand(reader, indexPath, indexSha256, streamId, cursor, verb = "read") {
  return [process.execPath, reader, verb, indexPath, indexSha256, streamId, ...(cursor ? [cursor] : [])]
    .map(shellQuote).join(" ");
}

function literalWords(command) {
  const words = [];
  let word = "", started = false, quote = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (char === "\\") {
      const next = command[++i];
      if (next === undefined || next === "\n") return null;
      if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) word += "\\";
      word += next;
      started = true;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (["$", "`"].includes(char)) return null;
      else word += char;
    } else if (["'", '"'].includes(char)) {
      quote = char; started = true;
    } else if (char === " " || char === "\t") {
      if (started) words.push(word);
      word = ""; started = false;
    } else {
      // Literal argv only. Expansion, redirection and shell control operators
      // are not valid alternate spellings of a trusted reader invocation.
      if ("\n\r\0;|&<>`$()*?[]{}~#".includes(char)) return null;
      word += char; started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

// Compare literal argv, including normal host shell quoting differences, but
// never evaluate shell syntax or credit echo/printf/model-authored frame text.
export function isContentCommand(observed, expected) {
  if (typeof observed !== "string") return false;
  const target = literalWords(expected);
  const words = observedWords(observed);
  return target !== null && words !== null && JSON.stringify(words) === JSON.stringify(target);
}

function observedWords(observed) {
  if (typeof observed !== "string") return null;
  let words = literalWords(observed);
  if (words?.length === 3 && ["/bin/zsh", "/bin/bash", "/bin/sh"].includes(words[0]) &&
      ["-lc", "-c"].includes(words[1])) words = literalWords(words[2]);
  return words;
}

export async function readContentSnapshot(indexPath, expectedDigest) {
  assert(DIGEST.test(expectedDigest));
  const absolute = path.resolve(indexPath);
  assert.equal(await realpath(absolute), absolute, "Content index path is not physical");
  const info = await lstat(absolute);
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= MAX_STREAM_BYTES);
  const raw = await readFile(absolute);
  assert.equal(contentDigest(raw), expectedDigest, "Content index changed");
  const index = JSON.parse(decoder.decode(raw));
  exact(index, ["protocol", "streams"]);
  assert.equal(index.protocol, CONTENT_PROTOCOL);
  assert(Array.isArray(index.streams) && index.streams.length > 0 && index.streams.length <= MAX_REVIEW_PATHS,
    "Native review path budget exceeded");
  const ids = new Set();
  const paths = new Set();
  let totalBytes = 0;
  for (const stream of index.streams) {
    exact(stream, ["id", "binding"]);
    assert(/^s[0-9]{6}$/.test(stream.id) && !ids.has(stream.id));
    ids.add(stream.id);
    identity(stream.binding);
    totalBytes += stream.binding.bytes;
    assert(totalBytes <= MAX_REVIEW_DIFF_BYTES, "Native review aggregate diff budget exceeded");
    assert(!paths.has(stream.binding.path));
    paths.add(stream.binding.path);
  }
  return { index, directory: path.dirname(absolute) };
}

export async function readContentStream(directory, stream) {
  const target = path.join(directory, `${stream.id}.diff`);
  assert.equal(await realpath(target), target, "Content stream path is not physical");
  const info = await lstat(target);
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= MAX_STREAM_BYTES);
  const bytes = await readFile(target);
  boundBytes(bytes, stream.binding);
  return bytes;
}

export function observeContentCoverage(jsonl, { streams, indexSha256, executionId, model, reasoningEffort }) {
  assert(Array.isArray(streams) && streams.length > 0 && new Set(streams.map(stream => stream.id)).size === streams.length);
  for (const stream of streams) boundBytes(stream.bytes, stream.binding);
  const coverage = new Map(streams.map(stream => [stream.id, {
    ...stream, cursor: initialContentCursor(stream.binding), pages: 0, bytesObserved: 0,
    eof: false, acknowledged: false, lastFrameDigest: null
  }]));
  const calls = new Map(), incompleteReads = [];
  let nextBatchCursor = initialBatchCursor(indexSha256), batchCount = 0, lastBatchDigest = null, allEof = false;
  let pendingAcknowledgements = [];
  let transport = null, turnId = null, turnCompleted = false, corrections = 0, consecutiveCorrections = 0, finalAcknowledged = false;
  for (const line of String(jsonl).split("\n").filter(line => line.trim())) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error("Native review event stream is truncated or is not JSONL"); }
    assert(event && typeof event === "object" && !Array.isArray(event));
    if (event.type === "bw.transport.bound") {
      assert(!transport, "Mixed native review transports");
      assert.equal(event.protocol, VISIBLE_TRANSPORT);
      assert.equal(event.executionId, executionId);
      assert.equal(event.model, model);
      assert.equal(event.reasoningEffort, reasoningEffort);
      assert(SUPPORTED_CODEX_VERSIONS.includes(event.codexVersion), "Unknown native review history implementation");
      assert(DIGEST.test(event.modelCapabilitySha256), "Missing native model capability binding");
      assert.deepEqual(event.directOnlyNamespaces, ["bw_review"], "Unverified direct-only tool exposure");
      assert.equal(event.indexSha256, indexSha256);
      assert(typeof event.threadId === "string" && event.threadId);
      assert.equal(event.toolOutputTokenLimit, HISTORY_TOKEN_LIMIT);
      assert.equal(event.maxOutputBytes, MAX_BATCH_BYTES);
      assert(event.readOnly === true && event.ephemeral === true && event.externalToolsDisabled === true);
      transport = event;
    } else if (event.method === "turn/started") {
      assert(transport && !turnId && !turnCompleted, "Mixed native review turns");
      assert.equal(event.params.threadId, transport.threadId);
      assert(typeof event.params.turn.id === "string" && event.params.turn.id);
      turnId = event.params.turn.id;
    } else if (event.method === "turn/completed") {
      assert(transport && turnId && !turnCompleted, "Duplicate native review terminal");
      assert.equal(event.params.threadId, transport.threadId);
      assert.equal(event.params.turn.id, turnId);
      assert.equal(event.params.turn.status, "completed", "Native review turn failed");
      assert.equal(event.params.turn.error, null);
      turnCompleted = true;
    } else if (["turn.failed", "error", "bw.transport.failed", "bw.transport.blocked"].includes(event.type) || event.method === "error") {
      throw new Error("Native review event stream contains a failed execution");
    } else if (event.method === "rawResponseItem/completed") {
      assert(transport && turnId && !turnCompleted, "Content observation outside the active turn");
      assert.equal(event.params.threadId, transport.threadId);
      assert.equal(event.params.turnId, turnId);
      const item = event.params.item;
      if (["custom_tool_call", "local_shell_call", "web_search_call"].includes(item.type)) {
        throw new Error("Non-direct tool call cannot prove native review coverage");
      }
      if (item.type === "function_call" && item.name === "content" && item.namespace === "bw_review") {
        assert(typeof item.call_id === "string" && item.call_id && !calls.has(item.call_id), "Duplicate content call identity");
        assert(!finalAcknowledged, "Content session is already acknowledged");
        const args = JSON.parse(item.arguments);
        contentRequestMatches(args, args);
        calls.set(item.call_id, { args, completed: false });
      } else if (item.type === "function_call_output" && calls.has(item.call_id)) {
        const call = calls.get(item.call_id);
        assert(!call.completed, "Duplicate content response identity");
        call.completed = true;
        // Raw app-server items also precede history truncation. The separately
        // pinned host history policy and conservative serialized-body bound
        // are required; the raw event on its own proves nothing about delivery.
        const text = item.output;
        if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BATCH_BYTES ||
            Buffer.byteLength(JSON.stringify(text)) > HISTORY_TOKEN_LIMIT * 4) {
          incompleteReads.push({ itemId: item.call_id, streamId: "all", cursor: nextBatchCursor,
            reason: "Model input exceeds the pinned history transport budget", resolved: false });
          continue;
        }
        const expected = allEof ? { page: null, acknowledge: lastBatchDigest } :
          { page: batchCount, acknowledge: null };
        const matches = contentRequestMatches(call.args, expected);
        if (text.startsWith("BW_CONTENT_RETRY_V2\n")) {
          assert(!matches, "Spurious content correction cannot replace a valid read");
          assert.equal(text, contentCorrection(indexSha256, expected, ++consecutiveCorrections, ++corrections), "Forged content correction");
          continue;
        }
        assert(matches, "Uncorrected content request cannot advance coverage");
        if (allEof) {
          if (text === "BW_CONTENT_ACK:" + lastBatchDigest + "\n") {
            for (const state of pendingAcknowledgements) state.acknowledged = true;
            pendingAcknowledgements = [];
            finalAcknowledged = true;
            consecutiveCorrections = 0;
          }
          continue;
        }
        let batch;
        try { batch = consumeContentPage(text, streams, indexSha256, nextBatchCursor, batchCount); }
        catch (error) {
          incompleteReads.push({ itemId: item.call_id, streamId: "all", cursor: nextBatchCursor,
            reason: error.message, resolved: false });
          continue;
        }
        consecutiveCorrections = 0;
        for (const state of pendingAcknowledgements) state.acknowledged = true;
        pendingAcknowledgements = [];
        for (const missing of incompleteReads) {
          if (missing.cursor === nextBatchCursor) missing.resolved = true;
        }
        for (const observation of batch.observations) {
          const state = coverage.get(observation.streamId);
          state.pages++;
          state.bytesObserved = observation.deliveredThrough;
          state.cursor = observation.cursor;
          state.eof = observation.contentComplete;
          state.lastFrameDigest = observation.frameDigest;
          if (state.eof) pendingAcknowledgements.push(state);
        }
        nextBatchCursor = batch.cursor;
        lastBatchDigest = batch.batchDigest;
        allEof = batch.contentComplete;
        batchCount++;
      }
    }
  }
  // Old exec JSONL raw logs have no model-input contract. No legacy fallback.
  if (transport) assert(turnId && turnCompleted, "Native review event stream has no complete terminal");
  const records = [...coverage.values()].map(state => ({ path: state.binding.path,
    streamId: state.id, sha256: state.binding.sha256, expectedBytes: state.binding.bytes,
    observedBytes: state.bytesObserved, pages: state.pages, complete: state.eof && state.acknowledged,
    nextCursor: state.cursor, lastFrameDigest: state.lastFrameDigest,
    eofObserved: state.eof, acknowledged: state.acknowledged }));
  return { protocol: CONTENT_PROTOCOL, expectedPaths: records.length,
    observedPaths: records.filter(record => record.complete).length,
    complete: Boolean(transport && turnCompleted && records.every(record => record.complete)), records,
    transport: transport ? { protocol: transport.protocol, codexVersion: transport.codexVersion,
      model: transport.model, reasoningEffort: transport.reasoningEffort,
      directOnlyNamespaces: transport.directOnlyNamespaces,
      modelCapabilitySha256: transport.modelCapabilitySha256, toolOutputTokenLimit: transport.toolOutputTokenLimit,
      maxOutputBytes: transport.maxOutputBytes, wireRequestCaptured: false } : null,
    semanticReviewAccepted: false, incompleteReads, batchCount, corrections, consecutiveCorrections, nextBatchCursor,
    lastBatchDigest, eventStreamSha256: contentDigest(String(jsonl)) };
}
