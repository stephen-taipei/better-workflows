import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseStrictJsonV1, StrictJsonValidationError } from "../lib/strict-json-v1.mjs";

function expectCode(fn, code) {
  assert.throws(fn, error => error instanceof StrictJsonValidationError && error.code === code);
}

test("strict JSON accepts one complete value and the exact UTF-8 byte boundary", () => {
  const text = ' {"name":"測試","items":[1,true,null]}\n';
  const bytes = Buffer.byteLength(text, "utf8");
  const value = parseStrictJsonV1(text, { maxBytes: bytes });
  assert.equal(value.name, "測試");
  assert.deepEqual(value.items, [1, true, null]);
  expectCode(() => parseStrictJsonV1(text, { maxBytes: bytes - 1 }), "ESTRICT_JSON_SIZE");
});

test("strict JSON rejects direct and decoded duplicate object keys", () => {
  expectCode(() => parseStrictJsonV1('{"a":1,"a":2}', { maxBytes: 64 }), "ESTRICT_JSON_DUPLICATE_KEY");
  expectCode(() => parseStrictJsonV1('{"a":1,"\\u0061":2}', { maxBytes: 64 }), "ESTRICT_JSON_DUPLICATE_KEY");
});

test("strict JSON rejects trailing bytes, a second root value, malformed escapes and trailing commas", () => {
  for (const text of ['{"a":1}x', '{}{}', '{"a":"\\x"}', '{"a":1,}']) {
    expectCode(() => parseStrictJsonV1(text, { maxBytes: 64 }), "ESTRICT_JSON_INVALID");
  }
});

test("strict JSON validates primitive input and options without invoking accessors", () => {
  expectCode(() => parseStrictJsonV1(Buffer.from("{}"), { maxBytes: 8 }), "ESTRICT_JSON_INPUT");
  expectCode(() => parseStrictJsonV1("{}", new Proxy({ maxBytes: 8 }, {})), "ESTRICT_JSON_INPUT");

  let touched = false;
  const options = {};
  Object.defineProperty(options, "maxBytes", {
    enumerable: true,
    get() {
      touched = true;
      return 8;
    }
  });
  expectCode(() => parseStrictJsonV1("{}", options), "ESTRICT_JSON_INPUT");
  assert.equal(touched, false, "maxBytes getter must never execute");
});

test("strict parser remains wired into receipt and protected-input consumers", async () => {
  const consumers = [
    "formal-evaluator.mjs",
    "formal-candidate-coverage-v1.mjs",
    "formal-protected-admission-v1.mjs",
    "formal-protected-observer-v2.mjs",
    "formal-protected-observer-preparation-v2.mjs",
    "formal-completion-replay-v1.mjs"
  ];
  for (const name of consumers) {
    const source = await readFile(fileURLToPath(new URL(`../lib/${name}`, import.meta.url)), "utf8");
    assert.match(source, /strict-json-v1\.mjs/, `${name} must import the strict parser`);
    assert.match(source, /parseStrictJsonV1\(/, `${name} must call the strict parser`);
  }
});
