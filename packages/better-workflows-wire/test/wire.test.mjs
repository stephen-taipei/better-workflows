import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createFrameDecoder,
  createFrameEncoder,
  decodeFrames,
  encodeFrame,
  WireFrameError,
} from '../src/index.mjs';

function expectCode(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof WireFrameError);
    assert.equal(error.code, code);
    return true;
  });
}

function asBytes(text) {
  return new TextEncoder().encode(text);
}

test('round trips UTF-8 payloads when every byte arrives in its own chunk', () => {
  const payload = {
    greeting: '繁體中文 · Ελληνικά · العربية · 🙂',
    numbers: [0, -1.25, 42],
    nested: { ok: true },
  };
  const bytes = encodeFrame(payload);
  const decoder = createFrameDecoder();
  const frames = [];
  for (const byte of bytes) {
    frames.push(...decoder.push(Uint8Array.of(byte)));
  }
  frames.push(...decoder.end());
  assert.deepEqual(frames, [{ protocolVersion: 1, payload }]);
  assert.equal(decoder.framesDecoded, 1);
});

test('accepts CRLF and handles a split multi-byte sequence at every boundary', () => {
  const frame = encodeFrame({ text: '分片🙂' });
  const crlf = new Uint8Array(frame.byteLength + 1);
  crlf.set(frame.subarray(0, -1), 0);
  crlf.set([0x0d, 0x0a], frame.byteLength - 1);

  for (let split = 0; split <= crlf.byteLength; split += 1) {
    const decoder = createFrameDecoder();
    const frames = [
      ...decoder.push(crlf.subarray(0, split)),
      ...decoder.push(crlf.subarray(split)),
      ...decoder.end(),
    ];
    assert.deepEqual(frames, [{ protocolVersion: 1, payload: { text: '分片🙂' } }], `split ${split}`);
  }
});

test('enforces empty-line policy and supports an explicit skip policy', () => {
  const frame = encodeFrame(null);
  const withEmptyLine = new Uint8Array(frame.byteLength + 1);
  withEmptyLine.set([0x0a], 0);
  withEmptyLine.set(frame, 1);
  expectCode(() => decodeFrames(withEmptyLine), 'ERR_EMPTY_LINE');
  assert.deepEqual(
    decodeFrames(withEmptyLine, { allowEmptyLines: true }),
    [{ protocolVersion: 1, payload: null }],
  );
});

test('rejects partial EOF and enforces the bounded frame size', () => {
  const frame = encodeFrame({ value: 'partial' });
  const decoder = createFrameDecoder();
  decoder.push(frame.subarray(0, -1));
  expectCode(() => decoder.end(), 'ERR_UNEXPECTED_EOF');

  expectCode(() => encodeFrame({ long: '0123456789' }, { maxFrameBytes: 10 }), 'ERR_FRAME_TOO_LARGE');
  expectCode(
    () => createFrameDecoder({ maxFrameBytes: 64, maxChunkBytes: 8 }).push(new Uint8Array(9)),
    'ERR_CHUNK_TOO_LARGE',
  );
  expectCode(
    () => createFrameDecoder({ maxFrameBytes: 64, maxChunkBytes: 8 }).push(new Uint8Array(9).fill(0x0a)),
    'ERR_CHUNK_TOO_LARGE',
  );
  const bounded = createFrameDecoder({ maxFrameBytes: 64, maxChunkBytes: 64 });
  bounded.push(new Uint8Array(63));
  expectCode(() => bounded.push(new Uint8Array(64)), 'ERR_FRAME_TOO_LARGE');
});

test('bounds encoder depth, decoder depth, and frames returned per push', () => {
  const nestedAt = (depth) => {
    let value = 0;
    for (let index = 0; index < depth; index += 1) value = { child: value };
    return value;
  };
  for (const depth of [1, 64, 128]) {
    const exact = nestedAt(depth);
    const bytes = encodeFrame(exact, { maxDepth: depth });
    assert.deepEqual(decodeFrames(bytes, { maxDepth: depth }), [{ protocolVersion: 1, payload: exact }]);
  }
  const nested = nestedAt(8);
  expectCode(() => encodeFrame(nested, { maxDepth: 4 }), 'ERR_MAX_DEPTH');
  const deepFrame = encodeFrame(nested, { maxDepth: 32 });
  expectCode(() => decodeFrames(deepFrame, { maxDepth: 4 }), 'ERR_MAX_DEPTH');
  expectCode(() => encodeFrame({}, { maxDepth: Number.MAX_SAFE_INTEGER }), 'ERR_INVALID_OPTIONS');

  const one = encodeFrame({ one: 1 });
  const three = new Uint8Array(one.byteLength * 3);
  three.set(one, 0);
  three.set(one, one.byteLength);
  three.set(one, one.byteLength * 2);
  expectCode(
    () => createFrameDecoder({ maxFramesPerPush: 2, maxChunkBytes: three.byteLength }).push(three),
    'ERR_TOO_MANY_FRAMES',
  );
});

test('rejects unknown protocol versions and non-neutral envelope members', () => {
  const versionTwo = encodeFrame({ ok: true }, { protocolVersion: 2 });
  expectCode(() => decodeFrames(versionTwo), 'ERR_UNKNOWN_PROTOCOL');
  expectCode(
    () => decodeFrames(asBytes('{"protocolVersion":1,"payload":null,"auth":"no"}\n')),
    'ERR_INVALID_ENVELOPE',
  );
});

test('rejects malformed UTF-8 and unsupported newline forms', () => {
  const invalidUtf8 = Uint8Array.from([
    0x7b, 0x22, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x63, 0x6f, 0x6c, 0x56, 0x65,
    0x72, 0x73, 0x69, 0x6f, 0x6e, 0x22, 0x3a, 0x31, 0x2c, 0x22, 0x70, 0x61,
    0x79, 0x6c, 0x6f, 0x61, 0x64, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
    0x0a,
  ]);
  expectCode(() => decodeFrames(invalidUtf8), 'ERR_INVALID_UTF8');

  expectCode(
    () => decodeFrames(asBytes('{"protocolVersion":1,"payload":null}\rX\n')),
    'ERR_INVALID_NEWLINE',
  );
});

test('strict JSON rejects grammar mutations, duplicate keys, and prototype keys', () => {
  const valid = '{"protocolVersion":1,"payload":{"value":1}}\n';
  const mutations = [
    valid.replace('1}}', '1,}'),
    valid.replace('"payload"', 'payload'),
    '{"protocolVersion":1,"payload":NaN}\n',
    '{"protocolVersion":1,"payload":1e400}\n',
    '{"protocolVersion":1,"payload":{"x":1,"x":2}}\n',
    '{"protocolVersion":1,"payload":{"__proto__":{}}}\n',
  ];
  for (const mutation of mutations) {
    expectCode(() => decodeFrames(asBytes(mutation)), mutation.includes('"x":1') ? 'ERR_DUPLICATE_KEY' : mutation.includes('__proto__') ? 'ERR_FORBIDDEN_KEY' : 'ERR_INVALID_JSON');
  }

  assert.deepEqual(
    decodeFrames(asBytes('{"protocolVersion":1,"payload":{"x":1,"x":2}}\n'), { strictJSON: false }),
    [{ protocolVersion: 1, payload: { x: 2 } }],
  );
});

test('encoder rejects unsafe and unsupported JavaScript values', () => {
  expectCode(() => encodeFrame(undefined), 'ERR_UNSUPPORTED_VALUE');
  expectCode(() => encodeFrame(Number.NaN), 'ERR_UNSUPPORTED_VALUE');
  expectCode(() => encodeFrame(Number.POSITIVE_INFINITY), 'ERR_UNSUPPORTED_VALUE');
  expectCode(() => encodeFrame(1n), 'ERR_UNSUPPORTED_VALUE');
  expectCode(() => encodeFrame(new Date()), 'ERR_UNSUPPORTED_VALUE');
  const cyclic = {};
  cyclic.self = cyclic;
  expectCode(() => encodeFrame(cyclic), 'ERR_UNSUPPORTED_VALUE');
  const forbidden = {};
  Object.defineProperty(forbidden, '__proto__', { value: true, enumerable: true });
  expectCode(() => encodeFrame(forbidden), 'ERR_FORBIDDEN_KEY');
  expectCode(() => encodeFrame('\ud800'), 'ERR_UNSUPPORTED_VALUE');
  expectCode(
    () => decodeFrames(asBytes('{"protocolVersion":1,"payload":"\\ud800"}\n')),
    'ERR_INVALID_JSON',
  );
  expectCode(
    () => encodeFrame({ large: 'x'.repeat(100_000) }, { maxFrameBytes: 1024 }),
    'ERR_FRAME_TOO_LARGE',
  );
});

test('singleFrame and failed/closed decoder state are deterministic', () => {
  const frame = encodeFrame({ one: 1 });
  const two = new Uint8Array(frame.byteLength * 2);
  two.set(frame, 0);
  two.set(frame, frame.byteLength);
  expectCode(() => createFrameDecoder({ singleFrame: true }).push(two), 'ERR_MULTIPLE_FRAMES');

  const decoder = createFrameDecoder();
  decoder.push(frame);
  decoder.end();
  expectCode(() => decoder.end(), 'ERR_DECODER_CLOSED');
});

test('package source has no core imports or governance-type names', async () => {
  const source = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /plugins\/better-workflows|better-workflows\/core|native-review-transport/);
  assert.doesNotMatch(source, /TaskContract|Evidence|ActionCapability|ApprovalEnvelope|ExecutionHandle|StopRequest|Receipt|HostTrust|Policy/);
  assert.doesNotMatch(source, /node:(?:http|https)|\b(?:eval|spawn|fetch)\s*\(/);
});

test('package self-reference resolves through its ESM export map', async () => {
  const packageApi = await import('@better-workflows/wire');
  const bytes = packageApi.encodeFrame({ exported: true });
  assert.deepEqual(packageApi.decodeFrames(bytes), [{ protocolVersion: 1, payload: { exported: true } }]);
});
