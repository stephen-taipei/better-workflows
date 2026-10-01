/*
 * Copyright 2026 Better Workflows contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { TextDecoder, TextEncoder } from 'node:util';

const DEFAULT_PROTOCOL_VERSION = 1;
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_MAX_DEPTH = 128;
const MAX_CONFIGURED_DEPTH = 128;
const DEFAULT_MAX_FRAMES_PER_PUSH = 128;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const JSON_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const HEX_DIGITS = /^[0-9a-fA-F]{4}$/;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Error raised for a rejected frame, option, chunk, or decoder state.
 * `code` is the stable machine-readable part of the error contract.
 */
export class WireFrameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WireFrameError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WireFrameError(code, message);
}

function isPlainOptions(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeOptions(options, { decoder }) {
  const input = options === undefined ? {} : options;
  if (!isPlainOptions(input)) {
    fail('ERR_INVALID_OPTIONS', 'options must be a plain object');
  }

  const protocolVersion = input.protocolVersion === undefined
    ? DEFAULT_PROTOCOL_VERSION
    : input.protocolVersion;
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1) {
    fail('ERR_INVALID_OPTIONS', 'protocolVersion must be a positive safe integer');
  }

  const maxFrameBytes = input.maxFrameBytes === undefined
    ? DEFAULT_MAX_FRAME_BYTES
    : input.maxFrameBytes;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 2) {
    fail('ERR_INVALID_OPTIONS', 'maxFrameBytes must be a safe integer of at least 2');
  }

  const maxDepth = input.maxDepth === undefined ? DEFAULT_MAX_DEPTH : input.maxDepth;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_CONFIGURED_DEPTH) {
    fail('ERR_INVALID_OPTIONS', `maxDepth must be a safe integer from 1 through ${MAX_CONFIGURED_DEPTH}`);
  }

  if (!decoder) {
    return Object.freeze({ protocolVersion, maxFrameBytes, maxDepth });
  }

  const allowEmptyLines = input.allowEmptyLines === undefined ? false : input.allowEmptyLines;
  const strictJSON = input.strictJSON === undefined ? true : input.strictJSON;
  const singleFrame = input.singleFrame === undefined ? false : input.singleFrame;
  const maxChunkBytes = input.maxChunkBytes === undefined ? maxFrameBytes : input.maxChunkBytes;
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1) {
    fail('ERR_INVALID_OPTIONS', 'maxChunkBytes must be a positive safe integer');
  }
  const maxFramesPerPush = input.maxFramesPerPush === undefined
    ? DEFAULT_MAX_FRAMES_PER_PUSH
    : input.maxFramesPerPush;
  if (!Number.isSafeInteger(maxFramesPerPush) || maxFramesPerPush < 1) {
    fail('ERR_INVALID_OPTIONS', 'maxFramesPerPush must be a positive safe integer');
  }
  for (const [name, value] of Object.entries({ allowEmptyLines, strictJSON, singleFrame })) {
    if (typeof value !== 'boolean') {
      fail('ERR_INVALID_OPTIONS', `${name} must be a boolean`);
    }
  }

  return Object.freeze({
    protocolVersion,
    maxFrameBytes,
    maxDepth,
    maxChunkBytes,
    maxFramesPerPush,
    allowEmptyLines,
    strictJSON,
    singleFrame,
  });
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function rejectForbiddenKey(key) {
  if (FORBIDDEN_KEYS.has(key)) {
    fail('ERR_FORBIDDEN_KEY', `object key ${JSON.stringify(key)} is not allowed`);
  }
}

function arrayIndexName(name) {
  if (name === '0') return true;
  if (!/^[1-9]\d*$/.test(name)) return false;
  const numeric = Number(name);
  return Number.isSafeInteger(numeric) && numeric >= 0 && String(numeric) === name;
}

function jsonStringByteLength(value, remaining) {
  let length = 2;
  if (length > remaining) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let increment;
    if (code === 0x22 || code === 0x5c) {
      increment = 2;
    } else if (code <= 0x1f) {
      increment = code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d
        ? 2
        : 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      increment = 4;
      index += 1;
    } else if (code <= 0x7f) {
      increment = 1;
    } else if (code <= 0x7ff) {
      increment = 2;
    } else {
      increment = 3;
    }
    length += increment;
    if (length > remaining) return null;
  }
  return length;
}

class ByteBudget {
  constructor(limit) {
    this.limit = limit;
    this.used = 0;
  }

  add(length) {
    if (length > this.limit - this.used) {
      fail('ERR_FRAME_TOO_LARGE', `encoded frame exceeds ${this.limit + 1} bytes`);
    }
    this.used += length;
  }

  addJSONText(text) {
    this.add(text.length);
  }

  addJSONString(value, path) {
    const length = jsonStringByteLength(value, this.limit - this.used);
    if (length === null) {
      fail('ERR_FRAME_TOO_LARGE', `${path} cannot fit within the configured frame limit`);
    }
    this.add(length);
  }
}

function serializeJSONValue(value, path, stack, budget, depth, maxDepth) {
  if (value === null) {
    budget.addJSONText('null');
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      budget.addJSONText(value ? 'true' : 'false');
      return value ? 'true' : 'false';
    case 'string':
      if (hasLoneSurrogate(value)) {
        fail('ERR_UNSUPPORTED_VALUE', `${path} contains an unpaired UTF-16 surrogate`);
      }
      budget.addJSONString(value, path);
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        fail('ERR_UNSUPPORTED_VALUE', `${path} must contain only finite numbers`);
      }
      {
        const json = JSON.stringify(value);
        budget.addJSONText(json);
        return json;
      }
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      fail('ERR_UNSUPPORTED_VALUE', `${path} contains an unsupported ${typeof value}`);
      break;
    default:
      break;
  }

  if (depth > maxDepth) {
    fail('ERR_MAX_DEPTH', `${path} exceeds maxDepth ${maxDepth}`);
  }
  if (stack.has(value)) {
    fail('ERR_UNSUPPORTED_VALUE', `${path} contains a cyclic object`);
  }
  stack.add(value);

  let result;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail('ERR_UNSUPPORTED_VALUE', `${path} must be a plain array`);
    }
    if (value.length > Number.MAX_SAFE_INTEGER) {
      fail('ERR_UNSUPPORTED_VALUE', `${path} is too large`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail('ERR_UNSUPPORTED_VALUE', `${path} contains symbol keys`);
    }
    const names = Object.getOwnPropertyNames(value);
    for (const name of names) {
      if (name !== 'length' && !arrayIndexName(name)) {
        fail('ERR_UNSUPPORTED_VALUE', `${path} contains a non-index array property`);
      }
    }
    budget.add(1);
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        fail('ERR_UNSUPPORTED_VALUE', `${path}[${index}] is missing or accessor-backed`);
      }
      if (index > 0) budget.add(1);
      items.push(serializeJSONValue(descriptor.value, `${path}[${index}]`, stack, budget, depth + 1, maxDepth));
    }
    budget.add(1);
    result = `[${items.join(',')}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('ERR_UNSUPPORTED_VALUE', `${path} must be a plain object`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail('ERR_UNSUPPORTED_VALUE', `${path} contains symbol keys`);
    }
    const names = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value);
    if (names.length !== keys.length) {
      fail('ERR_UNSUPPORTED_VALUE', `${path} contains non-enumerable properties`);
    }
    budget.add(1);
    const entries = [];
    for (const [index, key] of keys.entries()) {
      if (index > 0) budget.add(1);
      rejectForbiddenKey(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        fail('ERR_UNSUPPORTED_VALUE', `${path}.${key} is accessor-backed`);
      }
      if (hasLoneSurrogate(key)) {
        fail('ERR_UNSUPPORTED_VALUE', `${path} contains an unpaired UTF-16 surrogate in a key`);
      }
      budget.addJSONString(key, `${path} key`);
      budget.add(1);
      entries.push(`${JSON.stringify(key)}:${serializeJSONValue(descriptor.value, `${path}.${key}`, stack, budget, depth + 1, maxDepth)}`);
    }
    budget.add(1);
    result = `{${entries.join(',')}}`;
  }

  stack.delete(value);
  return result;
}

class StrictJSONParser {
  constructor(text, strictJSON, maxDepth) {
    this.text = text;
    this.strictJSON = strictJSON;
    this.maxDepth = maxDepth;
    this.index = 0;
  }

  parse() {
    this.skipWhitespace();
    // The envelope is framing metadata. Start its payload at depth zero so
    // encoder and decoder apply the same maxDepth contract to user data.
    const value = this.parseValue(-1);
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      fail('ERR_INVALID_JSON', 'trailing bytes after JSON value');
    }
    return value;
  }

  skipWhitespace() {
    while (this.index < this.text.length && JSON_WHITESPACE.has(this.text.charCodeAt(this.index))) {
      this.index += 1;
    }
  }

  parseValue(depth = 0) {
    this.skipWhitespace();
    if (this.index >= this.text.length) {
      fail('ERR_INVALID_JSON', 'expected a JSON value');
    }
    if (depth > this.maxDepth) {
      fail('ERR_MAX_DEPTH', `JSON value exceeds maxDepth ${this.maxDepth}`);
    }
    const character = this.text[this.index];
    if (character === '{') return this.parseObject(depth);
    if (character === '[') return this.parseArray(depth);
    if (character === '"') return this.parseString();
    if (this.text.startsWith('true', this.index)) {
      this.index += 4;
      return true;
    }
    if (this.text.startsWith('false', this.index)) {
      this.index += 5;
      return false;
    }
    if (this.text.startsWith('null', this.index)) {
      this.index += 4;
      return null;
    }
    return this.parseNumber();
  }

  parseString() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        const token = this.text.slice(start, this.index);
        let value;
        try {
          value = JSON.parse(token);
        } catch {
          fail('ERR_INVALID_JSON', 'invalid JSON string escape');
        }
        if (hasLoneSurrogate(value)) {
          fail('ERR_INVALID_JSON', 'JSON string contains an unpaired UTF-16 surrogate');
        }
        return value;
      }
      if (code < 0x20) {
        fail('ERR_INVALID_JSON', 'JSON strings cannot contain raw control characters');
      }
      if (code === 0x5c) {
        this.index += 1;
        if (this.index >= this.text.length) {
          fail('ERR_INVALID_JSON', 'incomplete JSON string escape');
        }
        const escape = this.text[this.index];
        if ('"\\/bfnrt'.includes(escape)) {
          this.index += 1;
          continue;
        }
        if (escape === 'u') {
          const hex = this.text.slice(this.index + 1, this.index + 5);
          if (hex.length !== 4 || !HEX_DIGITS.test(hex)) {
            fail('ERR_INVALID_JSON', 'invalid JSON unicode escape');
          }
          this.index += 5;
          continue;
        }
        fail('ERR_INVALID_JSON', 'invalid JSON string escape');
      }
      this.index += 1;
    }
    fail('ERR_INVALID_JSON', 'unterminated JSON string');
  }

  parseNumber() {
    const match = JSON_NUMBER_PATTERN.exec(this.text.slice(this.index));
    if (!match) {
      fail('ERR_INVALID_JSON', 'invalid JSON value');
    }
    const token = match[0];
    this.index += token.length;
    const value = Number(token);
    if (!Number.isFinite(value)) {
      fail('ERR_INVALID_JSON', 'JSON number is outside the finite range');
    }
    return value;
  }

  parseArray(depth) {
    this.index += 1;
    const values = [];
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      return values;
    }
    while (true) {
      values.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.text[this.index] === ']') {
        this.index += 1;
        return values;
      }
      if (this.text[this.index] !== ',') {
        fail('ERR_INVALID_JSON', 'expected comma or closing array bracket');
      }
      this.index += 1;
      this.skipWhitespace();
      if (this.text[this.index] === ']') {
        fail('ERR_INVALID_JSON', 'trailing commas are not allowed');
      }
    }
  }

  parseObject(depth) {
    this.index += 1;
    const value = {};
    const keys = new Set();
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return value;
    }
    while (true) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') {
        fail('ERR_INVALID_JSON', 'object keys must be JSON strings');
      }
      const key = this.parseString();
      rejectForbiddenKey(key);
      if (keys.has(key) && this.strictJSON) {
        fail('ERR_DUPLICATE_KEY', `duplicate JSON object key ${JSON.stringify(key)}`);
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ':') {
        fail('ERR_INVALID_JSON', 'expected colon after object key');
      }
      this.index += 1;
      const member = this.parseValue(depth + 1);
      Object.defineProperty(value, key, {
        configurable: true,
        enumerable: true,
        value: member,
        writable: true,
      });
      this.skipWhitespace();
      if (this.text[this.index] === '}') {
        this.index += 1;
        return value;
      }
      if (this.text[this.index] !== ',') {
        fail('ERR_INVALID_JSON', 'expected comma or closing object brace');
      }
      this.index += 1;
      this.skipWhitespace();
      if (this.text[this.index] === '}') {
        fail('ERR_INVALID_JSON', 'trailing commas are not allowed');
      }
    }
  }
}

function parseFrameText(text, options) {
  let parsed;
  try {
    parsed = new StrictJSONParser(text, options.strictJSON, options.maxDepth).parse();
  } catch (error) {
    if (error instanceof WireFrameError) throw error;
    fail('ERR_INVALID_JSON', 'invalid JSON frame');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('ERR_INVALID_ENVELOPE', 'frame envelope must be a JSON object');
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes('protocolVersion') || !keys.includes('payload')) {
    fail('ERR_INVALID_ENVELOPE', 'frame envelope must contain only protocolVersion and payload');
  }
  if (parsed.protocolVersion !== options.protocolVersion) {
    fail('ERR_UNKNOWN_PROTOCOL', `unsupported protocolVersion ${JSON.stringify(parsed.protocolVersion)}`);
  }
  return Object.freeze({
    protocolVersion: parsed.protocolVersion,
    payload: parsed.payload,
  });
}

function copyBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  fail('ERR_INVALID_CHUNK', 'decoder input must be a Uint8Array or ArrayBuffer');
}

function concatBytes(left, right) {
  if (left.byteLength === 0) return right.slice();
  if (right.byteLength === 0) return left.slice();
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left, 0);
  output.set(right, left.byteLength);
  return output;
}

function firstByte(bytes, byte, start) {
  for (let index = start; index < bytes.byteLength; index += 1) {
    if (bytes[index] === byte) return index;
  }
  return -1;
}

function checkPendingFrameBound(pending, incoming, maxFrameBytes) {
  const newline = firstByte(incoming, 0x0a, 0);
  const combinedFirstFrameBytes = pending.byteLength
    + (newline === -1 ? incoming.byteLength : newline + 1);
  if (combinedFirstFrameBytes > maxFrameBytes) {
    fail('ERR_FRAME_TOO_LARGE', `buffered frame exceeds ${maxFrameBytes} bytes`);
  }
}

function rejectBareCarriageReturn(bytes) {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0d && index !== bytes.byteLength - 1) {
      fail('ERR_INVALID_NEWLINE', 'only LF or CRLF line endings are supported');
    }
  }
}

function decodeLine(line, options) {
  if (line.byteLength === 0) {
    if (options.allowEmptyLines) return null;
    fail('ERR_EMPTY_LINE', 'empty JSONL lines are not allowed');
  }
  let content = line;
  if (content[content.byteLength - 1] === 0x0d) {
    content = content.subarray(0, content.byteLength - 1);
  }
  if (content.byteLength === 0) {
    if (options.allowEmptyLines) return null;
    fail('ERR_EMPTY_LINE', 'empty JSONL lines are not allowed');
  }
  for (const byte of content) {
    if (byte === 0x0d) {
      fail('ERR_INVALID_NEWLINE', 'only LF or CRLF line endings are supported');
    }
  }
  if (content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) {
    fail('ERR_INVALID_JSON', 'UTF-8 BOM is not a JSONL frame');
  }
  let text;
  try {
    text = UTF8_DECODER.decode(content);
  } catch {
    fail('ERR_INVALID_UTF8', 'frame bytes are not valid UTF-8');
  }
  return parseFrameText(text, options);
}

/**
 * Create an encoder for one neutral JSONL transport protocol version.
 */
export function createFrameEncoder(options = {}) {
  const normalized = normalizeOptions(options, { decoder: false });
  return Object.freeze({
    protocolVersion: normalized.protocolVersion,
    maxFrameBytes: normalized.maxFrameBytes,
    maxDepth: normalized.maxDepth,
    encodeFrame(payload) {
      const prefix = `{"protocolVersion":${normalized.protocolVersion},"payload":`;
      const budget = new ByteBudget(normalized.maxFrameBytes - 1);
      budget.addJSONText(prefix);
      const payloadJSON = serializeJSONValue(
        payload,
        'payload',
        new WeakSet(),
        budget,
        0,
        normalized.maxDepth,
      );
      budget.add(2);
      const bytes = UTF8_ENCODER.encode(`${prefix}${payloadJSON}}\n`);
      if (bytes.byteLength > normalized.maxFrameBytes) {
        fail('ERR_FRAME_TOO_LARGE', `encoded frame is ${bytes.byteLength} bytes; limit is ${normalized.maxFrameBytes}`);
      }
      return bytes;
    },
  });
}

/**
 * Create an incremental decoder for bounded JSONL frames.
 * A complete frame must end in LF; CRLF is accepted before that LF.
 */
export function createFrameDecoder(options = {}) {
  const normalized = normalizeOptions(options, { decoder: true });
  let pending = new Uint8Array(0);
  let frameCount = 0;
  let closed = false;
  let terminalError = null;

  function guardOpen() {
    if (terminalError) throw terminalError;
    if (closed) fail('ERR_DECODER_CLOSED', 'decoder has already reached EOF');
  }

  function reject(error) {
    if (error instanceof WireFrameError) {
      terminalError = error;
      throw error;
    }
    const wrapped = new WireFrameError('ERR_INVALID_FRAME', 'frame decoding failed');
    terminalError = wrapped;
    throw wrapped;
  }

  function push(chunk) {
    guardOpen();
    let bytes;
    try {
      bytes = copyBytes(chunk);
      if (bytes.byteLength > normalized.maxChunkBytes) {
        fail('ERR_CHUNK_TOO_LARGE', `input chunk is ${bytes.byteLength} bytes; limit is ${normalized.maxChunkBytes}`);
      }
      checkPendingFrameBound(pending, bytes, normalized.maxFrameBytes);
      pending = concatBytes(pending, bytes);
      if (pending.byteLength > normalized.maxFrameBytes && firstByte(pending, 0x0a, 0) === -1) {
        fail('ERR_FRAME_TOO_LARGE', `buffered frame exceeds ${normalized.maxFrameBytes} bytes`);
      }

      const frames = [];
      let offset = 0;
      while (true) {
        const newline = firstByte(pending, 0x0a, offset);
        if (newline === -1) break;
        const frameBytes = pending.subarray(offset, newline);
        const wireLength = newline - offset + 1;
        if (wireLength > normalized.maxFrameBytes) {
          fail('ERR_FRAME_TOO_LARGE', `frame is ${wireLength} bytes; limit is ${normalized.maxFrameBytes}`);
        }
        const frame = decodeLine(frameBytes, normalized);
        if (frame !== null) {
          if (frames.length >= normalized.maxFramesPerPush) {
            fail('ERR_TOO_MANY_FRAMES', `push exceeds maxFramesPerPush ${normalized.maxFramesPerPush}`);
          }
          if (normalized.singleFrame && frameCount > 0) {
            fail('ERR_MULTIPLE_FRAMES', 'singleFrame decoder received more than one frame');
          }
          frameCount += 1;
          frames.push(frame);
        }
        offset = newline + 1;
      }

      pending = pending.slice(offset);
      if (pending.byteLength > normalized.maxFrameBytes) {
        fail('ERR_FRAME_TOO_LARGE', `buffered frame exceeds ${normalized.maxFrameBytes} bytes`);
      }
      rejectBareCarriageReturn(pending);
      return frames;
    } catch (error) {
      return reject(error);
    }
  }

  function end() {
    guardOpen();
    try {
      if (pending.byteLength !== 0) {
        fail('ERR_UNEXPECTED_EOF', 'EOF arrived before a complete LF-terminated frame');
      }
      closed = true;
      return [];
    } catch (error) {
      return reject(error);
    }
  }

  return Object.freeze({
    protocolVersion: normalized.protocolVersion,
    maxFrameBytes: normalized.maxFrameBytes,
    maxDepth: normalized.maxDepth,
    maxChunkBytes: normalized.maxChunkBytes,
    maxFramesPerPush: normalized.maxFramesPerPush,
    get framesDecoded() {
      return frameCount;
    },
    push,
    end,
  });
}

/** Encode one frame without retaining an encoder instance. */
export function encodeFrame(payload, options = {}) {
  return createFrameEncoder(options).encodeFrame(payload);
}

/** Decode all complete frames from one byte sequence. */
export function decodeFrames(bytes, options = {}) {
  const decoder = createFrameDecoder(options);
  return [...decoder.push(bytes), ...decoder.end()];
}
