// SPDX-License-Identifier: AGPL-3.0-only
// Strict JSON syntax and duplicate-key validation for bounded receipt inputs.
// This module does not authenticate bytes or grant admission authority.

import { types } from "node:util";

const ERROR_CODES = Object.freeze({
  input: "ESTRICT_JSON_INPUT",
  size: "ESTRICT_JSON_SIZE",
  invalid: "ESTRICT_JSON_INVALID",
  duplicate: "ESTRICT_JSON_DUPLICATE_KEY"
});

export class StrictJsonValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StrictJsonValidationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StrictJsonValidationError(code, message);
}

function readMaxBytes(options) {
  if (options === null || typeof options !== "object" || types.isProxy(options)) {
    fail(ERROR_CODES.input, "options.maxBytes must be provided as a positive safe integer");
  }

  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(options, "maxBytes");
  } catch {
    fail(ERROR_CODES.input, "options.maxBytes must be provided as a positive safe integer");
  }

  const maxBytes = descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
    ? descriptor.value
    : undefined;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    fail(ERROR_CODES.input, "options.maxBytes must be provided as a positive safe integer");
  }
  return maxBytes;
}

function scanStrictJsonText(text) {
  let offset = 0;
  let rootStarted = false;
  const stack = [];

  function invalid() {
    fail(ERROR_CODES.invalid, "input is not one complete standard JSON value");
  }

  function skipWhitespace() {
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      offset += 1;
    }
  }

  function readStringToken() {
    const start = offset;
    offset += 1; // opening quote

    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        return text.slice(start, offset);
      }
      if (code === 0x5c) {
        offset += 1;
        if (offset >= text.length) invalid();
        const escape = text.charCodeAt(offset);
        if (escape === 0x75) {
          for (let digit = 1; digit <= 4; digit += 1) {
            const hex = text.charCodeAt(offset + digit);
            if (!((hex >= 0x30 && hex <= 0x39) ||
                  (hex >= 0x41 && hex <= 0x46) ||
                  (hex >= 0x61 && hex <= 0x66))) invalid();
          }
          offset += 5; // u plus four hexadecimal digits
          continue;
        }
        if (escape !== 0x22 && escape !== 0x5c && escape !== 0x2f &&
            escape !== 0x62 && escape !== 0x66 && escape !== 0x6e &&
            escape !== 0x72 && escape !== 0x74) invalid();
        offset += 1;
        continue;
      }
      if (code <= 0x1f) invalid();
      offset += 1;
    }

    invalid();
  }

  function readNumber() {
    if (text.charCodeAt(offset) === 0x2d) offset += 1;
    if (offset >= text.length) invalid();

    let code = text.charCodeAt(offset);
    if (code === 0x30) {
      offset += 1;
    } else if (code >= 0x31 && code <= 0x39) {
      do {
        offset += 1;
        code = text.charCodeAt(offset);
      } while (code >= 0x30 && code <= 0x39);
    } else {
      invalid();
    }

    if (text.charCodeAt(offset) === 0x2e) {
      offset += 1;
      code = text.charCodeAt(offset);
      if (code < 0x30 || code > 0x39) invalid();
      do {
        offset += 1;
        code = text.charCodeAt(offset);
      } while (code >= 0x30 && code <= 0x39);
    }

    code = text.charCodeAt(offset);
    if (code === 0x65 || code === 0x45) {
      offset += 1;
      code = text.charCodeAt(offset);
      if (code === 0x2b || code === 0x2d) {
        offset += 1;
        code = text.charCodeAt(offset);
      }
      if (code < 0x30 || code > 0x39) invalid();
      do {
        offset += 1;
        code = text.charCodeAt(offset);
      } while (code >= 0x30 && code <= 0x39);
    }
  }

  function readValue() {
    if (offset >= text.length) invalid();
    const code = text.charCodeAt(offset);

    if (code === 0x7b) {
      offset += 1;
      stack.push({ type: "object", state: "keyOrEnd", keys: new Set() });
      return;
    }
    if (code === 0x5b) {
      offset += 1;
      stack.push({ type: "array", state: "valueOrEnd" });
      return;
    }
    if (code === 0x22) {
      readStringToken();
      return;
    }
    if (code === 0x2d || (code >= 0x30 && code <= 0x39)) {
      readNumber();
      return;
    }
    if (text.startsWith("true", offset)) {
      offset += 4;
      return;
    }
    if (text.startsWith("false", offset)) {
      offset += 5;
      return;
    }
    if (text.startsWith("null", offset)) {
      offset += 4;
      return;
    }
    invalid();
  }

  function readObjectKey(frame) {
    if (text.charCodeAt(offset) !== 0x22) invalid();
    const token = readStringToken();
    let key;
    try {
      key = JSON.parse(token);
    } catch {
      invalid();
    }
    if (frame.keys.has(key)) {
      fail(ERROR_CODES.duplicate, "an object contains a duplicate decoded key");
    }
    frame.keys.add(key);
    frame.state = "colon";
  }

  while (true) {
    if (stack.length === 0) {
      skipWhitespace();
      if (!rootStarted) {
        if (offset >= text.length) invalid();
        rootStarted = true;
        readValue();
        continue;
      }
      if (offset !== text.length) invalid();
      return;
    }

    skipWhitespace();
    const frame = stack[stack.length - 1];
    const code = text.charCodeAt(offset);

    if (frame.type === "object") {
      if (frame.state === "keyOrEnd") {
        if (code === 0x7d) {
          offset += 1;
          stack.pop();
        } else {
          readObjectKey(frame);
        }
        continue;
      }
      if (frame.state === "key") {
        readObjectKey(frame);
        continue;
      }
      if (frame.state === "colon") {
        if (code !== 0x3a) invalid();
        offset += 1;
        frame.state = "value";
        continue;
      }
      if (frame.state === "value") {
        frame.state = "commaOrEnd";
        readValue();
        continue;
      }
      if (frame.state === "commaOrEnd") {
        if (code === 0x2c) {
          offset += 1;
          frame.state = "key";
        } else if (code === 0x7d) {
          offset += 1;
          stack.pop();
        } else {
          invalid();
        }
        continue;
      }
      invalid();
    }

    if (frame.state === "valueOrEnd") {
      if (code === 0x5d) {
        offset += 1;
        stack.pop();
      } else {
        frame.state = "commaOrEnd";
        readValue();
      }
      continue;
    }
    if (frame.state === "value") {
      frame.state = "commaOrEnd";
      readValue();
      continue;
    }
    if (frame.state === "commaOrEnd") {
      if (code === 0x2c) {
        offset += 1;
        frame.state = "value";
      } else if (code === 0x5d) {
        offset += 1;
        stack.pop();
      } else {
        invalid();
      }
      continue;
    }
    invalid();
  }
}

/** Parse one bounded JSON value after rejecting duplicate decoded object keys. */
export function parseStrictJsonV1(text, options) {
  if (typeof text !== "string") {
    fail(ERROR_CODES.input, "text must be a primitive string");
  }
  const maxBytes = readMaxBytes(options);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    fail(ERROR_CODES.size, "input exceeds maxBytes");
  }

  scanStrictJsonText(text);
  try {
    return JSON.parse(text);
  } catch {
    fail(ERROR_CODES.invalid, "input is not one complete standard JSON value");
  }
}
