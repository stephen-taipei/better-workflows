import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  privateKeyFromRaw
} from "../host-trust.mjs";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "host-trust.mjs"
);

test("host signer reconstructs Ed25519 keys and signs canonical verifier payloads", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const reconstructed = privateKeyFromRaw(seed);
  const payload = {
    execution: { role: "candidate", attempt: 1 },
    provider: "codex",
    schemaVersion: 1
  };
  const bytes = Buffer.from(canonicalJson(payload), "utf8");
  const signature = sign(null, bytes, reconstructed);
  assert.equal(verify(null, bytes, publicKey, signature), true);
});

test("host trust helper fixes authority paths and does not accept environment path overrides", async () => {
  const source = await readFile(SCRIPT, "utf8");
  assert.match(source, /"\/etc\/better-workflows\/codex-trust-root\.json"/);
  assert.match(source, /"\/private\/var\/db\/better-workflows\/codex-attestation-ed25519\.raw"/);
  assert.match(source, /Refusing implicit rotation or overwrite/);
  assert.match(source, /sign-result/);
  assert.match(source, /responseDigest/);
  assert.match(source, /trustRootDigest/);
  assert.doesNotMatch(source, /BW_(?:TRUST|PRIVATE|ATTESTATION)/);
});
