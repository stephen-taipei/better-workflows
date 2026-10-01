import assert from "node:assert/strict";
import test from "node:test";
import { supportsV5NodeRuntime } from "../lib/runtime-support.mjs";

test("V5 accepts Node 22.14 and newer stable runtimes", () => {
  for (const version of ["22.14.0", "22.14.1", "22.23.1", "23.0.0", "24.0.0", "24.12.0", "25.0.0"]) {
    assert.equal(supportsV5NodeRuntime(version), true, version);
  }
});

test("V5 rejects Node versions below the 22.14 floor and malformed versions", () => {
  for (const version of ["22.13.99", "21.7.3", "20.18.0", "22.14", "v24.12.0", "22.14.0-rc.1", "", null]) {
    assert.equal(supportsV5NodeRuntime(version), false, String(version));
  }
});
