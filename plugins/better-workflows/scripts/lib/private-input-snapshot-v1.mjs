// SPDX-License-Identifier: AGPL-3.0-only
// Private data snapshots; authentication and admission remain caller-owned.
import { types as utilTypes } from "node:util";

// Capture the intrinsics used at module initialization. This is a data
// boundary, not a sandbox for an isolate whose primordials were already
// compromised.
const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const defineProperty = Object.defineProperty;
const createObject = Object.create;
const setPrototypeOf = Object.setPrototypeOf;
const hasOwn = Object.hasOwn;
const ObjectPrototype = Object.prototype;
const ArrayPrototype = Array.prototype;
const isArray = Array.isArray;
const isSafeInteger = Number.isSafeInteger;
const isFiniteNumber = Number.isFinite;
const NumberIntrinsic = Number;
const numberToString = Number.prototype.toString;
const charCodeAt = String.prototype.charCodeAt;
const numberStringify = JSON.stringify;
const ArrayIntrinsic = Array;
const Uint8ArrayIntrinsic = Uint8Array;
const WeakSetIntrinsic = WeakSet;
const isProxy = utilTypes.isProxy;
const isUint8Array = utilTypes.isUint8Array;
const isArrayBuffer = utilTypes.isArrayBuffer;
const isSharedArrayBuffer = utilTypes.isSharedArrayBuffer;
const ArrayBufferIntrinsic = ArrayBuffer;
const SharedArrayBufferIntrinsic = typeof SharedArrayBuffer === "function" ? SharedArrayBuffer : null;
const arrayPush = Array.prototype.push;
const arrayPop = Array.prototype.pop;
const weakSetAdd = WeakSet.prototype.add;
const weakSetHas = WeakSet.prototype.has;
const weakSetDelete = WeakSet.prototype.delete;
const stringCodeUnitAt = (value, index) => apply(charCodeAt, value, [index]);
const unsupportedTypeNames = [
  "isArgumentsObject", "isAnyArrayBuffer", "isArrayBuffer", "isArrayBufferView",
  "isBigIntObject", "isBooleanObject", "isBoxedPrimitive", "isDataView", "isDate",
  "isCryptoKey", "isExternal", "isGeneratorObject", "isKeyObject", "isMap", "isMapIterator", "isModuleNamespaceObject",
  "isNativeError", "isNumberObject", "isPromise", "isRegExp", "isSet", "isSetIterator",
  "isSharedArrayBuffer", "isStringObject", "isSymbolObject", "isTypedArray", "isWeakMap",
  "isWebAssemblyCompiledModule", "isWeakSet"
];
const unsupportedTypePredicates = [];
for (let index = 0; index < unsupportedTypeNames.length; index += 1) {
  const predicate = utilTypes[unsupportedTypeNames[index]];
  if (typeof predicate === "function") apply(arrayPush, unsupportedTypePredicates, [predicate]);
}

const ERROR_MESSAGES = createObject(null);
ERROR_MESSAGES.ESNAPSHOT_INPUT = "private snapshot rejected unsupported input";
ERROR_MESSAGES.ESNAPSHOT_SIZE = "private snapshot exceeds its byte bound";
ERROR_MESSAGES.ESNAPSHOT_ACCESSOR = "private snapshot rejected an accessor";
ERROR_MESSAGES.ESNAPSHOT_CYCLE = "private snapshot rejected a cycle";
ERROR_MESSAGES.ESNAPSHOT_BYTES = "private snapshot rejected unsupported bytes";

export class PrivateInputSnapshotError extends Error {
  constructor(code) {
    const normalizedCode = typeof code === "string" && hasOwn(ERROR_MESSAGES, code)
      ? code
      : "ESNAPSHOT_INPUT";
    super(ERROR_MESSAGES[normalizedCode]);
    this.name = "PrivateInputSnapshotError";
    this.code = normalizedCode;
  }
}

function reject(code) {
  throw new PrivateInputSnapshotError(code);
}

function readMaxBytes(options) {
  if (options === null || typeof options !== "object" || isProxy(options)) {
    reject("ESNAPSHOT_INPUT");
  }
  const prototype = getPrototypeOf(options);
  if (prototype !== ObjectPrototype && prototype !== null) reject("ESNAPSHOT_INPUT");
  const descriptor = getOwnPropertyDescriptor(options, "maxBytes");
  if (descriptor === undefined) reject("ESNAPSHOT_INPUT");
  if (!hasOwn(descriptor, "value")) reject("ESNAPSHOT_ACCESSOR");
  const maxBytes = descriptor.value;
  if (!isSafeInteger(maxBytes) || maxBytes <= 0) reject("ESNAPSHOT_INPUT");
  return maxBytes;
}

function charge(state, amount) {
  if (amount > state.maxBytes - state.bytes) reject("ESNAPSHOT_SIZE");
  state.bytes += amount;
}

function chargeQuotedString(state, value) {
  charge(state, 2); // JSON string quotes
  const length = value.length;
  for (let index = 0; index < length; index += 1) {
    const code = stringCodeUnitAt(value, index);
    if (code === 0x22 || code === 0x5c) {
      charge(state, 2);
    } else if (code <= 0x1f) {
      if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
        charge(state, 2);
      } else {
        charge(state, 6);
      }
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < length ? stringCodeUnitAt(value, index + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        charge(state, 4); // A valid UTF-16 pair is emitted as one UTF-8 scalar.
        index += 1;
      } else {
        charge(state, 6); // Well-formed JSON.stringify escapes lone surrogates.
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      charge(state, 6);
    } else if (code <= 0x7f) {
      charge(state, 1);
    } else if (code <= 0x7ff) {
      charge(state, 2);
    } else {
      charge(state, 3);
    }
  }
}

function chargeNumber(state, value) {
  if (!isFiniteNumber(value)) reject("ESNAPSHOT_INPUT");
  const serialized = numberStringify(value);
  if (typeof serialized !== "string") reject("ESNAPSHOT_INPUT");
  // Finite JSON number tokens contain ASCII characters only.
  charge(state, serialized.length);
}

function defineData(target, key, value) {
  defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

function makeSnapshotObject() {
  return createObject(null);
}

function makeSnapshotArray() {
  const output = new ArrayIntrinsic();
  setPrototypeOf(output, null);
  return output;
}

function isAccessor(descriptor) {
  return !hasOwn(descriptor, "value");
}

function arrayIndexFromKey(key) {
  if (key === "0") return 0;
  if (key.length === 0 || key.length > 10) return null;
  for (let index = 0; index < key.length; index += 1) {
    const code = stringCodeUnitAt(key, index);
    if (code < 0x30 || code > 0x39) return null;
  }
  const number = NumberIntrinsic(key);
  if (!isSafeInteger(number) || number < 0 || number >= 0xffffffff) return null;
  if (apply(numberToString, number, []) !== key) return null;
  return number;
}

function push(stack, value) {
  apply(arrayPush, stack, [value]);
}

function pop(stack) {
  return apply(arrayPop, stack, []);
}

function weakHas(set, value) {
  return apply(weakSetHas, set, [value]);
}

function weakAdd(set, value) {
  apply(weakSetAdd, set, [value]);
}

function weakDelete(set, value) {
  apply(weakSetDelete, set, [value]);
}

function isUnsupportedExotic(value) {
  for (let index = 0; index < unsupportedTypePredicates.length; index += 1) {
    if (unsupportedTypePredicates[index](value)) return true;
  }
  return false;
}

/**
 * Copy JSON data into a detached private representation. maxBytes bounds the
 * UTF-8 size of JSON.stringify(snapshot), computed incrementally without
 * stringify's recursive call stack or a full serialized-string allocation.
 * Objects and arrays in the result have null prototypes; arrays must be dense.
 * Reflect.ownKeys materializes each complete own-key list before traversal can
 * stop on the byte bound, so maxBytes is not a total reflection/CPU bound.
 */
export function snapshotJsonDataV1(value, options) {
  const maxBytes = readMaxBytes(options);
  const state = { maxBytes, bytes: 0 };
  const active = new WeakSetIntrinsic();
  const stack = [{ kind: "value", input: value, parent: null, key: null }];
  let result;

  while (stack.length > 0) {
    const frame = pop(stack);
    if (frame.kind === "object" || frame.kind === "array") {
      if (frame.index >= frame.keys.length) {
        if (frame.kind === "array" && frame.nextIndex !== frame.length) reject("ESNAPSHOT_INPUT");
        charge(state, 1); // closing brace/bracket
        weakDelete(active, frame.input);
        continue;
      }

      const key = frame.keys[frame.index];
      frame.index += 1;
      push(stack, frame);
      if (typeof key !== "string") reject("ESNAPSHOT_INPUT");
      const descriptor = getOwnPropertyDescriptor(frame.input, key);
      if (descriptor === undefined) reject("ESNAPSHOT_INPUT");
      if (isAccessor(descriptor)) reject("ESNAPSHOT_ACCESSOR");

      if (frame.kind === "array") {
        if (key === "length") {
          if (descriptor.value !== frame.length) reject("ESNAPSHOT_INPUT");
          continue;
        }
        const arrayIndex = arrayIndexFromKey(key);
        if (arrayIndex === null) {
          if (descriptor.enumerable) reject("ESNAPSHOT_INPUT");
          continue;
        }
        if (arrayIndex !== frame.nextIndex || arrayIndex >= frame.length) reject("ESNAPSHOT_INPUT");
        if (frame.nextIndex > 0) charge(state, 1); // comma
        frame.nextIndex += 1;
        push(stack, { kind: "value", input: descriptor.value, parent: frame.output, key });
        continue;
      }

      if (!descriptor.enumerable) continue;
      if (frame.emitted > 0) charge(state, 1); // comma
      chargeQuotedString(state, key);
      charge(state, 1); // colon
      defineData(frame.output, key, undefined);
      frame.emitted += 1;
      push(stack, { kind: "value", input: descriptor.value, parent: frame.output, key });
      continue;
    }

    const input = frame.input;
    if (input === null) {
      charge(state, 4);
      if (frame.parent === null) result = null;
      else defineData(frame.parent, frame.key, null);
      continue;
    }
    const type = typeof input;
    if (type === "boolean") {
      charge(state, input ? 4 : 5);
      if (frame.parent === null) result = input;
      else defineData(frame.parent, frame.key, input);
      continue;
    }
    if (type === "string") {
      chargeQuotedString(state, input);
      if (frame.parent === null) result = input;
      else defineData(frame.parent, frame.key, input);
      continue;
    }
    if (type === "number") {
      chargeNumber(state, input);
      if (frame.parent === null) result = input;
      else defineData(frame.parent, frame.key, input);
      continue;
    }
    if (type !== "object" || isProxy(input) || isUnsupportedExotic(input)) reject("ESNAPSHOT_INPUT");
    if (weakHas(active, input)) reject("ESNAPSHOT_CYCLE");

    if (isArray(input)) {
      if (getPrototypeOf(input) !== ArrayPrototype) reject("ESNAPSHOT_INPUT");
      const lengthDescriptor = getOwnPropertyDescriptor(input, "length");
      if (lengthDescriptor === undefined || isAccessor(lengthDescriptor) ||
          !isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
          lengthDescriptor.value > 0xffffffff) {
        reject("ESNAPSHOT_INPUT");
      }
      const output = makeSnapshotArray();
      if (frame.parent === null) result = output;
      else defineData(frame.parent, frame.key, output);
      charge(state, 1); // opening bracket
      weakAdd(active, input);
      push(stack, {
        kind: "array",
        input,
        output,
        length: lengthDescriptor.value,
        nextIndex: 0,
        keys: ownKeys(input),
        index: 0
      });
      continue;
    }

    const prototype = getPrototypeOf(input);
    if (prototype !== ObjectPrototype && prototype !== null) reject("ESNAPSHOT_INPUT");
    const output = makeSnapshotObject();
    if (frame.parent === null) result = output;
    else defineData(frame.parent, frame.key, output);
    charge(state, 1); // opening brace
    weakAdd(active, input);
    push(stack, {
      kind: "object",
      input,
      output,
      keys: ownKeys(input),
      index: 0,
      emitted: 0
    });
  }

  return result;
}

const typedArrayPrototype = getPrototypeOf(Uint8ArrayIntrinsic.prototype);
const typedArrayBufferGetter = getOwnPropertyDescriptor(typedArrayPrototype, "buffer").get;
const typedArrayByteOffsetGetter = getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset").get;
const typedArrayLengthGetter = getOwnPropertyDescriptor(typedArrayPrototype, "length").get;
const typedArraySet = getOwnPropertyDescriptor(typedArrayPrototype, "set").value;
const arrayBufferPrototype = ArrayBufferIntrinsic.prototype;
const arrayBufferResizableGetter = getOwnPropertyDescriptor(arrayBufferPrototype, "resizable")?.get;
const sharedArrayBufferPrototype = SharedArrayBufferIntrinsic ? SharedArrayBufferIntrinsic.prototype : null;
const sharedArrayBufferResizableGetter = sharedArrayBufferPrototype
  ? getOwnPropertyDescriptor(sharedArrayBufferPrototype, "resizable")?.get
  : null;

/**
 * Copy a genuine Uint8Array or Buffer into a new, non-shared Uint8Array.
 * SharedArrayBuffer and resizable backing stores are rejected because this
 * boundary does not prove stable source bytes during capture.
 */
export function copyBoundedBytesV1(value, options) {
  const maxBytes = readMaxBytes(options);
  if (value === null || typeof value !== "object" || isProxy(value) || !isUint8Array(value)) {
    reject("ESNAPSHOT_BYTES");
  }

  let sourceBuffer;
  let sourceOffset;
  let sourceLength;
  try {
    sourceBuffer = apply(typedArrayBufferGetter, value, []);
    sourceOffset = apply(typedArrayByteOffsetGetter, value, []);
    sourceLength = apply(typedArrayLengthGetter, value, []);
  } catch {
    reject("ESNAPSHOT_BYTES");
  }
  if (!isSafeInteger(sourceLength) || sourceLength < 0) reject("ESNAPSHOT_BYTES");
  if (sourceLength > maxBytes) reject("ESNAPSHOT_SIZE");

  if (isSharedArrayBuffer(sourceBuffer)) {
    if (sharedArrayBufferResizableGetter && apply(sharedArrayBufferResizableGetter, sourceBuffer, [])) {
      reject("ESNAPSHOT_BYTES");
    }
    reject("ESNAPSHOT_BYTES");
  }
  if (!isArrayBuffer(sourceBuffer)) reject("ESNAPSHOT_BYTES");
  if (arrayBufferResizableGetter && apply(arrayBufferResizableGetter, sourceBuffer, [])) reject("ESNAPSHOT_BYTES");

  let sourceView;
  try {
    // Constructing a view also rejects a detached backing store, including a
    // detached zero-length view. The source offset/length came from intrinsics.
    sourceView = new Uint8ArrayIntrinsic(sourceBuffer, sourceOffset, sourceLength);
  } catch {
    reject("ESNAPSHOT_BYTES");
  }

  const output = new Uint8ArrayIntrinsic(sourceLength);
  try {
    // TypedArray#set takes the typed-array fast path; it does not consult an
    // overridden iterator, slice, species, or own length getter.
    apply(typedArraySet, output, [sourceView]);
  } catch {
    reject("ESNAPSHOT_BYTES");
  }
  return output;
}
