import assert from "node:assert/strict";
import { test } from "node:test";
import { problemsIn } from "./check-attribution.mjs";

const SHA = "0123456789abcdef";
const HUMAN = "6315361+stephen-taipei@users.noreply.github.com";

test("a commit by a person with a plain message is clean", () => {
  assert.deepEqual(problemsIn(SHA, HUMAN, HUMAN, "Fix the build\n\nMore detail."), []);
});

test("an Anthropic author or committer is refused", () => {
  assert.deepEqual(problemsIn(SHA, "noreply@anthropic.com", HUMAN, "x"), ["0123456: author is noreply@anthropic.com"]);
  assert.deepEqual(problemsIn(SHA, HUMAN, "noreply@anthropic.com", "x"), ["0123456: committer is noreply@anthropic.com"]);
});

test("Claude trailers and the generated-with line are refused", () => {
  const message = [
    "Subject",
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
    "Claude-Session: https://claude.ai/code/session_x",
  ].join("\n");
  assert.equal(problemsIn(SHA, HUMAN, HUMAN, message).length, 3);
});

test("a human co-author is fine, even at another address", () => {
  assert.deepEqual(problemsIn(SHA, HUMAN, HUMAN, "x\n\nCo-Authored-By: Jane Doe <jane@example.com>"), []);
  assert.equal(problemsIn(SHA, HUMAN, HUMAN, "x\n\nCo-Authored-By: Claude <bot@example.com>").length, 1);
});
