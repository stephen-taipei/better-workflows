import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  copyBoundedBytesV1,
  PrivateInputSnapshotError,
  snapshotJsonDataV1
} from "../lib/private-input-snapshot-v1.mjs";
import { captureFormalProtectedRequestV2 } from "../lib/formal-protected-capture-client-v2.mjs";

function expectCode(fn, code) {
  assert.throws(fn, error => error instanceof PrivateInputSnapshotError && error.code === code);
}

test("private JSON snapshot is detached, null-prototype data and breaks source aliasing", () => {
  const shared = { value: "original" };
  const input = { left: shared, right: shared, list: [shared] };
  const snapshot = snapshotJsonDataV1(input, { maxBytes: 256 });

  assert.equal(Object.getPrototypeOf(snapshot), null);
  assert.equal(Object.getPrototypeOf(snapshot.left), null);
  assert.equal(Object.getPrototypeOf(snapshot.list), null);
  assert.notEqual(snapshot.left, shared);
  assert.notEqual(snapshot.left, snapshot.right);
  assert.notEqual(snapshot.left, snapshot.list[0]);

  shared.value = "mutated";
  snapshot.left.value = "local";
  assert.equal(snapshot.right.value, "original");
  assert.equal(snapshot.list[0].value, "original");
});

test("private JSON snapshot rejects getters without executing them, custom prototypes and cycles", () => {
  let touched = false;
  const accessor = {};
  Object.defineProperty(accessor, "secret", {
    enumerable: true,
    get() {
      touched = true;
      return "leak";
    }
  });
  expectCode(() => snapshotJsonDataV1(accessor, { maxBytes: 64 }), "ESNAPSHOT_ACCESSOR");
  assert.equal(touched, false, "snapshot must inspect the descriptor without invoking the getter");

  const customPrototype = Object.create({ inherited: true });
  customPrototype.value = 1;
  expectCode(() => snapshotJsonDataV1(customPrototype, { maxBytes: 64 }), "ESNAPSHOT_INPUT");

  const cyclic = {};
  cyclic.self = cyclic;
  expectCode(() => snapshotJsonDataV1(cyclic, { maxBytes: 64 }), "ESNAPSHOT_CYCLE");
});

test("private JSON snapshot enforces the exact serialized UTF-8 byte limit", () => {
  const input = { text: "😀" };
  const exact = Buffer.byteLength(JSON.stringify(input), "utf8");
  const snapshot = snapshotJsonDataV1(input, { maxBytes: exact });
  assert.equal(snapshot.text, "😀");
  expectCode(() => snapshotJsonDataV1(input, { maxBytes: exact - 1 }), "ESNAPSHOT_SIZE");
});

test("private JSON snapshot rejects a custom array prototype", () => {
  const input = [1, 2];
  Object.setPrototypeOf(input, { custom: true });
  expectCode(() => snapshotJsonDataV1(input, { maxBytes: 64 }), "ESNAPSHOT_INPUT");
});

test("bounded byte copy is detached and rejects over-budget or shared storage", () => {
  const source = Buffer.from([1, 2, 3, 4]);
  const copied = copyBoundedBytesV1(source, { maxBytes: 4 });
  assert.deepEqual([...copied], [1, 2, 3, 4]);
  source[0] = 9;
  assert.equal(copied[0], 1);
  expectCode(() => copyBoundedBytesV1(source, { maxBytes: 3 }), "ESNAPSHOT_SIZE");

  if (typeof SharedArrayBuffer === "function") {
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    expectCode(() => copyBoundedBytesV1(shared, { maxBytes: 4 }), "ESNAPSHOT_BYTES");
  }
});

test("snapshot options are data-only and consumer boundaries snapshot before dispatch or parsing", async () => {
  let touched = false;
  const options = {};
  Object.defineProperty(options, "maxBytes", {
    get() {
      touched = true;
      return 64;
    }
  });
  expectCode(() => snapshotJsonDataV1({ ok: true }, options), "ESNAPSHOT_ACCESSOR");
  assert.equal(touched, false);

  const captureClient = await readFile(fileURLToPath(new URL("../lib/formal-protected-capture-client-v2.mjs", import.meta.url)), "utf8");
  assert.match(captureClient, /const copied = snapshotJsonDataV1\(/);
  assert.match(captureClient, /request\("capture", copied\)/);

  const observer = await readFile(fileURLToPath(new URL("../lib/formal-protected-observer-v2.mjs", import.meta.url)), "utf8");
  assert.match(observer, /parseStrictJsonV1\(JSON\.stringify\(snapshotJsonDataV1\(value, \{ maxBytes \}\)\), \{ maxBytes \}\)/);

  const admission = await readFile(fileURLToPath(new URL("../lib/formal-protected-admission-v1.mjs", import.meta.url)), "utf8");
  assert.match(admission, /const snapshot = snapshotJsonDataV1\(value, \{ maxBytes \}\)/);
  assert.match(admission, /copyBoundedBytesV1\(bytes, \{ maxBytes \}\)/);
});

test("protected capture snapshots caller data and bytes before request dispatch", async () => {
  const args = ["original"];
  const env = { TOKEN: "original" };
  const input = Buffer.from("original");
  let calls = 0;
  const result = await captureFormalProtectedRequestV2(async (operation, value) => {
    calls += 1;
    assert.equal(operation, "capture");
    args[0] = "changed";
    env.TOKEN = "changed";
    input[0] = 0;
    assert.equal(value.args.length, 1);
    assert.equal(value.args[0], "original");
    assert.equal(value.env.TOKEN, "original");
    assert.equal(value.input, Buffer.from("original").toString("base64"));
    assert.equal(Object.getPrototypeOf(value), null);
    assert.match(value.captureId, /^[a-f0-9]{32}$/);
    return { stdout: Buffer.from("out").toString("base64"), stderr: "" };
  }, () => assert.fail("no cancellation expected"), "/usr/bin/git", args,
  { cwd: "/tmp/example", env, input, encoding: null, onSpawn: null });
  assert.equal(calls, 1);
  assert.deepEqual(result.stdout, Buffer.from("out"));
  assert.deepEqual(result.stderr, Buffer.alloc(0));
});

test("protected capture rejects getters and proxies without dispatch or trap execution", async () => {
  let calls = 0, touched = 0;
  const request = () => { calls += 1; return Promise.resolve({ stdout: "", stderr: "" }); };
  const rejectOptions = async options => assert.rejects(
    captureFormalProtectedRequestV2(request, () => {}, "command", [], options),
    error => error instanceof PrivateInputSnapshotError &&
      ["ESNAPSHOT_ACCESSOR", "ESNAPSHOT_INPUT"].includes(error.code)
  );
  const inputAccessor = { cwd: "/tmp" };
  Object.defineProperty(inputAccessor, "input", { enumerable: true, get() { touched += 1; return "hidden"; } });
  await rejectOptions(inputAccessor);
  const signalAccessor = {};
  Object.defineProperty(signalAccessor, "abortSignal", { enumerable: true, get() { touched += 1; return null; } });
  await rejectOptions(signalAccessor);
  const nestedEnv = {};
  Object.defineProperty(nestedEnv, "TOKEN", { enumerable: true, get() { touched += 1; return "hidden"; } });
  await rejectOptions({ env: nestedEnv });
  await rejectOptions(new Proxy({}, { ownKeys() { touched += 1; throw new Error("trap invoked"); } }));
  assert.equal(touched, 0);
  assert.equal(calls, 0);
});

test("protected capture rejects over-budget, shared, detached and invalid input before dispatch", async () => {
  let calls = 0;
  const request = () => { calls += 1; return Promise.resolve({ stdout: "", stderr: "" }); };
  const run = input => captureFormalProtectedRequestV2(request, () => {}, "command", [], { input });
  await assert.rejects(run("x".repeat(128 * 1024 + 1)), { code: "ESNAPSHOT_SIZE" });
  await assert.rejects(run(new Uint8Array(128 * 1024 + 1)), { code: "ESNAPSHOT_SIZE" });
  await assert.rejects(run({ toString() { throw new Error("caller conversion ran"); } }), { code: "ESNAPSHOT_BYTES" });
  if (typeof SharedArrayBuffer === "function") {
    await assert.rejects(run(new Uint8Array(new SharedArrayBuffer(8))), { code: "ESNAPSHOT_BYTES" });
  }
  if (typeof structuredClone === "function") {
    const detached = new Uint8Array(8);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    await assert.rejects(run(detached), { code: "ESNAPSHOT_BYTES" });
  }
  assert.equal(calls, 0);
});

test("protected capture charges the generated ID against the broker's complete 128 KiB limit", async () => {
  let calls = 0;
  const request = async (_operation, value) => {
    calls += 1;
    assert.equal(Buffer.byteLength(JSON.stringify(value)), 128 * 1024 - 1);
    return { stdout: "", stderr: "" };
  };
  const run = input => captureFormalProtectedRequestV2(request, () => {}, "c", [], { input });
  // The fixed non-input fields, including the 32-digit captureId, occupy 83
  // bytes. 98,241 ASCII bytes encode to 130,988 base64 bytes.
  await run("x".repeat(98_241));
  await assert.rejects(run("x".repeat(98_242)), { code: "ESNAPSHOT_SIZE" });
  assert.equal(calls, 1, "an oversized complete request must not reach the broker");
});

test("protected capture checks an already aborted genuine signal before dispatch", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(captureFormalProtectedRequestV2(() => { calls += 1; }, () => {},
    "command", [], { abortSignal: controller.signal }), /cancelled before dispatch/);
  assert.equal(calls, 0);
});
