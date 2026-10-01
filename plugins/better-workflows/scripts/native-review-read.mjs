import assert from "node:assert/strict";
import { emitContentBatch, emitContentFrame, readContentSnapshot, readContentStream } from "./lib/native-review-content.mjs";

// This helper is intentionally read-only and does not write a cursor/receipt.
// Only observations in the parent-owned native event stream can advance it.
try {
  const [verb, indexPath, indexDigest, streamId, cursor, ...extra] = process.argv.slice(2);
  assert(["read", "ack"].includes(verb) && extra.length === 0, "Invalid bounded read command");
  const { index, directory } = await readContentSnapshot(indexPath, indexDigest);
  if (streamId === "all") {
    const output = verb === "read" ? await emitContentBatch(index.streams, indexDigest,
      stream => readContentStream(directory, stream), cursor) : (() => {
      assert(/^[a-f0-9]{64}$/.test(cursor), "Terminal batch digest required");
      return `BW_CONTENT_ACK:${cursor}\n`;
    })();
    await new Promise((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
    process.exit(0);
  }
  const stream = index.streams.find(value => value.id === streamId);
  assert(stream, "Stream is outside the immutable content index");
  const bytes = await readContentStream(directory, stream);
  let output;
  if (verb === "ack") {
    assert(/^[a-f0-9]{64}$/.test(cursor), "Terminal frame digest required");
    // The parent validates this digest against the previously observed EOF;
    // this output alone is never content-delivery or semantic-review evidence.
    output = `BW_CONTENT_ACK:${cursor}\n`;
  } else output = emitContentFrame(bytes, stream.binding, cursor);
  await new Promise((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
} catch (error) {
  process.stderr.write(`Bounded native review read rejected: ${error.message}\n`);
  process.exitCode = 1;
}
