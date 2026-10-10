import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("the stale-green demo behaves as its README describes", () => {
  const demo = fileURLToPath(new URL("../examples/stale-green/demo.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [demo], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /All steps behaved as described/);
});
