import assert from "node:assert/strict";
import test from "node:test";
import {
  findMergedPullRequest,
  normalizeStableVersion,
  parseRemoteTagCommit,
  releaseTagName,
  remoteTagMatches,
  versionChanged,
  versionSurfaces
} from "../lib/release-tag.mjs";

const SHA = "a".repeat(40);

test("release tag names distinguish stable main from dev prerelease integration", () => {
  assert.equal(releaseTagName({ branch: "main", version: "3.4.10", sha: SHA }), "v3.4.10");
  assert.equal(releaseTagName({ branch: "dev", version: "3.4.10", sha: SHA }), "v3.4.10-dev.aaaaaaaaaaaa");
});

test("only a version change creates a release candidate", () => {
  assert.equal(versionChanged("3.4.10", "3.4.9"), true);
  assert.equal(versionChanged("3.4.10", "3.4.10"), false);
  assert.equal(versionChanged("3.4.10", null), true);
});

test("package and plugin manifest versions must agree", () => {
  assert.equal(versionSurfaces({ version: "3.4.10" }, { version: "3.4.10+codex.20260814T170343" }), "3.4.10");
  assert.throws(
    () => versionSurfaces({ version: "3.4.10" }, { version: "3.4.11+codex.build" }),
    /do not match/
  );
  assert.throws(() => normalizeStableVersion("3.4.10-dev.1"), /stable semver/);
});

test("only the exact merged PR result for the target branch is eligible", () => {
  const pull = { number: 42, base: { ref: "dev" }, merged_at: "2026-08-14T00:00:00Z", merge_commit_sha: SHA };
  assert.equal(findMergedPullRequest([pull], { branch: "dev", sha: SHA }), pull);
  assert.equal(findMergedPullRequest([pull], { branch: "main", sha: SHA }), null);
  assert.equal(findMergedPullRequest([{ ...pull, merge_commit_sha: "b".repeat(40) }], { branch: "dev", sha: SHA }), null);
});

test("annotated and lightweight remote tags are compared by commit", () => {
  const output = [
    `${"b".repeat(40)}\trefs/tags/v3.4.10`,
    `${SHA}\trefs/tags/v3.4.10^{}`
  ].join("\n");
  assert.equal(parseRemoteTagCommit(output), SHA);
  assert.equal(remoteTagMatches(output, SHA), true);
  assert.equal(remoteTagMatches(output, "b".repeat(40)), false);
});
