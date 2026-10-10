import { createHash } from "node:crypto";

// Canonical JSON: sorted object keys, no undefined, finite numbers only.
export function canonicalJson(value) {
  return JSON.stringify(normalize(value, "$"));
}

function normalize(value, at) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${at} must be a finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${at}[${index}]`));
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError(`${at} must be a plain object`);
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError(`${at}.${key} is undefined`);
      out[key] = normalize(value[key], `${at}.${key}`);
    }
    return out;
  }
  throw new TypeError(`${at} has unsupported type ${typeof value}`);
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function digest(value) {
  return sha256(canonicalJson(value));
}
