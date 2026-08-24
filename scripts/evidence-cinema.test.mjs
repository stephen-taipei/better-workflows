import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "..");
const cinemaDirectory = path.join(repoRoot, "docs", "html", "evidence-cinema");
const pagePath = path.join(cinemaDirectory, "index.html");
const manifestPath = path.join(cinemaDirectory, "assets", "imagegen-manifest.md");

const expectedAssets = [
  "cast-lineup.webp",
  "character-root.webp",
  "character-pixel.webp",
  "character-ledger.webp",
  "character-vera.webp",
  "character-sentinel.webp",
  "character-echo.webp",
  "scene-01-goal.webp",
  "scene-02-binding.webp",
  "scene-03-evidence.webp",
  "scene-04-verifier.webp",
  "scene-05-ledger.webp",
  "scene-06-review.webp",
  "scene-07-gate.webp",
  "scene-08-reconcile.webp"
];

function relativeTargets(content) {
  return [...content.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((target) =>
      !target.startsWith("#")
      && !target.startsWith("data:")
      && !target.startsWith("//")
      && !/^[a-z][a-z0-9+.-]*:/i.test(target)
    )
    .map((target) => target.split("#", 1)[0].split("?", 1)[0]);
}

test("evidence cinema keeps eight replay scenes, two terminal branches, and accessible controls", async () => {
  const content = await readFile(pagePath, "utf8");
  assert.equal((content.match(/\bimage: "assets\/scene-/g) ?? []).length, 8);
  assert.equal((content.match(/class="cast-card"/g) ?? []).length, 6);
  assert.match(content, /data-ending="verified"/);
  assert.match(content, /data-ending="unknown"/);
  assert.match(content, /SANITIZED TEACHING REPLAY · NOT A LIVE RUN/);
  assert.match(content, /Provider reconciliation 是查證已發生什麼，不是再送一次請求/);
  assert.match(content, /prefers-reduced-motion: reduce/);
  assert.match(content, /aria-live="polite"/);
  assert.match(content, /id="story-progress" type="range"/);
  assert.match(content, /id="play-button"/);
  assert.doesNotMatch(content, /\bfetch\s*\(/);

  const ids = [...content.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "HTML ids must remain unique");

  const scripts = [...content.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: pagePath }));
});

test("evidence cinema references only existing repository-local files", async () => {
  const content = await readFile(pagePath, "utf8");
  for (const target of relativeTargets(content)) {
    await access(path.resolve(cinemaDirectory, target));
  }

  const overview = await readFile(path.join(repoRoot, "docs", "html", "index.html"), "utf8");
  const scenarios = await readFile(path.join(repoRoot, "docs", "html", "use-cases", "index.html"), "utf8");
  assert.match(overview, /href="evidence-cinema\/index\.html"/);
  assert.match(scenarios, /href="\.\.\/evidence-cinema\/index\.html"/);
});

test("generated cinema art is optimized, complete, and documented", async () => {
  const manifest = await readFile(manifestPath, "utf8");
  assert.match(manifest, /built-in image generation tool/);
  assert.match(manifest, /Final project assets: 1 lineup, 6 character cards, and 8 film scenes/);

  for (const name of expectedAssets) {
    const assetPath = path.join(cinemaDirectory, "assets", name);
    const [info, contents] = await Promise.all([stat(assetPath), readFile(assetPath)]);
    assert.ok(info.size > 10_000, name + " should contain a real illustration");
    assert.ok(info.size < 400_000, name + " should remain web-friendly");
    assert.equal(contents.subarray(0, 4).toString("ascii"), "RIFF", name);
    assert.equal(contents.subarray(8, 12).toString("ascii"), "WEBP", name);
  }
});
