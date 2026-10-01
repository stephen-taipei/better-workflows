import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MAX_REVIEW_IMAGE_BYTES } from "./native-review-content.mjs";

export const APP_SERVER_LINE_BYTES = 1024 * 1024;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

// Frame before decoding: readline buffers an entire unterminated line before a
// line listener can enforce a size limit. Async iteration also applies stream
// backpressure while the preceding tool request is being handled.
export async function* boundedJsonl(input, maximum) {
  let pieces = [], size = 0;
  const append = bytes => {
    if (!bytes.length) return;
    size += bytes.length;
    const limit = typeof maximum === "function" ? maximum() : maximum;
    assert(Number.isSafeInteger(limit) && limit > 0, "Invalid JSONL transport limit");
    assert(size <= limit, `App-server JSONL frame exceeds transport limit (${size} > ${limit})`);
    pieces.push(bytes);
  };
  for await (const chunk of input) {
    assert(Buffer.isBuffer(chunk), "JSONL transport must supply raw bytes");
    let start = 0, end;
    while ((end = chunk.indexOf(10, start)) !== -1) {
      append(chunk.subarray(start, end));
      let bytes = Buffer.concat(pieces, size);
      if (bytes.at(-1) === 13) bytes = bytes.subarray(0, -1);
      assert(bytes.length > 0, "Empty app-server JSONL frame");
      const line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      pieces = []; size = 0;
      yield line;
      start = end + 1;
    }
    append(chunk.subarray(start));
  }
  assert(size === 0, "App-server JSONL transport ended with an unterminated frame");
}

export function createImageInputPolicy({ prompt, images }) {
  assert(typeof prompt === "string" && Array.isArray(images), "Bound image input is required");
  let total = 0, encoded = 0;
  const expected = images.map(image => {
    assert(Number.isSafeInteger(image.bytes) && image.bytes > 0 && image.bytes <= 8 * 1024 * 1024 &&
      /^[a-f0-9]{64}$/.test(image.sha256), "Invalid image input binding");
    total += image.bytes;
    encoded += 4 * Math.ceil(image.bytes / 3);
    return { bytes: image.bytes, sha256: image.sha256 };
  });
  assert(images.length <= 256 && total <= MAX_REVIEW_IMAGE_BYTES, "Image input exceeds the approved budget");
  // Only a bound, byte-identical input-image echo may exceed the ordinary 1 MiB
  // event limit. The factor of two allows JSON slash escaping in base64 URLs;
  // metadata and text retain the ordinary limit. Model output gets no increase.
  const maxFrameBytes = APP_SERVER_LINE_BYTES + encoded * 2;
  let seen = false;
  return {
    maxFrameBytes,
    get observed() { return !images.length || seen; },
    validate(line, message, { threadId, turnId }) {
      const size = Buffer.byteLength(line);
      const item = message.params?.item;
      const echo = message.method === "rawResponseItem/completed" && item?.type === "message" &&
        item.role === "user" && Array.isArray(item.content) &&
        item.content[0]?.type === "input_text" && item.content[0].text === prompt;
      if (!echo) {
        assert(size <= APP_SERVER_LINE_BYTES, "Non-input app-server JSONL line exceeds transport limit");
        return APP_SERVER_LINE_BYTES;
      }
      assert(threadId && turnId && message.params.threadId === threadId && message.params.turnId === turnId,
        "Image input echo is not bound to the active turn");
      assert(!seen, "Duplicate bound input echo");
      assert(size <= maxFrameBytes, "Image input echo exceeds its bound transport budget");
      let n = 0;
      const metadata = item.content.map(part => {
        if (part.type === "input_text") {
          assert(Object.keys(part).every(key => ["type", "text"].includes(key)) && typeof part.text === "string",
            "Invalid image input text");
          return part;
        }
        assert(part.type === "input_image" && Object.keys(part).every(key => ["type", "image_url", "detail"].includes(key)),
          "Unexpected image input content");
        assert(part.detail == null || ["original", "high", "low", "auto"].includes(part.detail), "Invalid image detail");
        const binding = expected[n++];
        assert(binding && typeof part.image_url === "string", "Unexpected image input count");
        const comma = part.image_url.indexOf(",");
        assert(/^data:image\/(?:png|webp|jpeg|gif);base64$/.test(part.image_url.slice(0, comma)),
          "Image input must be inline bytes, not a URL or path");
        const encodedBytes = part.image_url.slice(comma + 1);
        assert(encodedBytes.length === 4 * Math.ceil(binding.bytes / 3), "Image input byte length changed");
        const bytes = Buffer.from(encodedBytes, "base64");
        assert(bytes.toString("base64") === encodedBytes && bytes.length === binding.bytes &&
          sha256(bytes) === binding.sha256, "Image input bytes differ from the authorized snapshot");
        return { ...part, image_url: `[sha256:${binding.sha256};bytes:${binding.bytes}]` };
      });
      assert(n === expected.length, "Image input echo omitted an authorized image");
      const envelope = { ...message, params: { ...message.params, item: { ...item, content: metadata } } };
      assert(Buffer.byteLength(JSON.stringify(envelope)) <= APP_SERVER_LINE_BYTES,
        "Image input metadata exceeds the ordinary transport limit");
      seen = true;
      return maxFrameBytes;
    }
  };
}
