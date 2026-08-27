import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "../../../..");
const cinemaDirectory = path.join(repoRoot, "docs", "html", "evidence-cinema");
const pagePath = path.join(cinemaDirectory, "index.html");
const manifestPath = path.join(cinemaDirectory, "assets", "imagegen-manifest.md");
const pluginCinemaDirectory = path.join(repoRoot, "plugins", "better-workflows", "ui", "evidence-cinema");
const canonicalCssPath = path.join(pluginCinemaDirectory, "cinema.css");
const canonicalRendererPath = path.join(pluginCinemaDirectory, "renderer.js");
const runtimePagePath = path.join(pluginCinemaDirectory, "runtime.html");

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

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function uint24le(contents, offset) {
  return contents[offset] | (contents[offset + 1] << 8) | (contents[offset + 2] << 16);
}

function webpDimensions(contents) {
  assert.equal(contents.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(contents.subarray(8, 12).toString("ascii"), "WEBP");
  let offset = 12;
  while (offset + 8 <= contents.length) {
    const kind = contents.subarray(offset, offset + 4).toString("ascii");
    const size = contents.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (kind === "VP8X") {
      return { width: uint24le(contents, payload + 4) + 1, height: uint24le(contents, payload + 7) + 1 };
    }
    if (kind === "VP8 ") {
      return {
        width: contents.readUInt16LE(payload + 6) & 0x3fff,
        height: contents.readUInt16LE(payload + 8) & 0x3fff
      };
    }
    if (kind === "VP8L") {
      const bits = contents.readUInt32LE(payload + 1);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    offset = payload + size + (size % 2);
  }
  throw new Error("WebP dimensions are unavailable");
}

test("evidence cinema keeps eight replay scenes, two terminal branches, and accessible controls", async () => {
  const [content, renderer] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(canonicalRendererPath, "utf8")
  ]);
  assert.equal((renderer.match(/\bimage: "assets\/scene-/g) ?? []).length, 8);
  assert.equal((content.match(/class="cast-card"/g) ?? []).length, 6);
  assert.match(content, /data-ending="verified"/);
  assert.match(content, /data-ending="unknown"/);
  assert.match(content, /SANITIZED TEACHING REPLAY · NOT A LIVE RUN/);
  assert.match(content, /Provider reconciliation 是查證已發生什麼，不是再送一次請求/);
  assert.match(content, /aria-live="polite"/);
  assert.match(content, /id="story-progress" type="range"/);
  assert.match(content, /id="play-button"/);
  assert.doesNotMatch(content, /<script>([\s\S]*?)<\/script>/);
  assert.match(content, /<script src="shared\/renderer\.js" defer><\/script>/);
  assert.match(renderer, /if \(replayMode !== "runtime"\) return true/);

  const ids = [...content.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "HTML ids must remain unique");

  assert.doesNotThrow(() => new vm.Script(renderer, { filename: canonicalRendererPath }));
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
    const pluginAssetPath = path.join(pluginCinemaDirectory, "assets", name);
    const [info, contents, pluginContents] = await Promise.all([
      stat(assetPath),
      readFile(assetPath),
      readFile(pluginAssetPath)
    ]);
    assert.ok(info.size > 10_000, name + " should contain a real illustration");
    assert.ok(info.size < 400_000, name + " should remain web-friendly");
    assert.equal(contents.subarray(0, 4).toString("ascii"), "RIFF", name);
    assert.equal(contents.subarray(8, 12).toString("ascii"), "WEBP", name);
    assert.equal(digest(pluginContents), digest(contents), `${name} plugin mirror must be byte-identical`);
    const dimensions = webpDimensions(contents);
    assert.ok(dimensions.width > 400 && dimensions.height > 400, `${name} dimensions`);
  }

  const lineup = webpDimensions(await readFile(path.join(cinemaDirectory, "assets", "cast-lineup.webp")));
  assert.deepEqual(lineup, { width: 1693, height: 929 });
});

test("cast lineup keeps its intrinsic ratio at desktop and mobile breakpoints", async () => {
  const [content, runtime, css, mirroredCss] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(runtimePagePath, "utf8"),
    readFile(canonicalCssPath, "utf8"),
    readFile(path.join(cinemaDirectory, "shared", "cinema.css"), "utf8")
  ]);
  assert.equal(css, mirroredCss);
  assert.match(content, /cast-lineup\.webp" width="1693" height="929"/);
  assert.match(runtime, /cast-lineup\.webp" width="1693" height="929"/);
  assert.match(css, /\.hero-art img \{[\s\S]*?width: 100%;[\s\S]*?max-width: 100%;[\s\S]*?height: auto;[\s\S]*?aspect-ratio: 1693 \/ 929;[\s\S]*?object-fit: contain;/);
  assert.match(css, /@media \(max-width: 1120px\)[\s\S]*?\.hero-art \{ max-width: 850px; margin-inline: auto; \}/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.hero-art \{ transform: none; \}/);
  assert.doesNotMatch(css, /data:image/);
});

test("runtime cinema is CSP-compatible, sanitized, and shares the canonical renderer", async () => {
  const [runtime, renderer, mirroredRenderer] = await Promise.all([
    readFile(runtimePagePath, "utf8"),
    readFile(canonicalRendererPath, "utf8"),
    readFile(path.join(cinemaDirectory, "shared", "renderer.js"), "utf8")
  ]);
  assert.equal(renderer, mirroredRenderer);
  assert.match(runtime, /data-replay-mode="runtime"/);
  assert.match(runtime, /href="\/assets\/cinema\.css"/);
  assert.match(runtime, /src="\/assets\/renderer\.js" defer/);
  assert.doesNotMatch(runtime, /<style\b|<script>([\s\S]*?)<\/script>|\son\w+=/i);
  assert.match(renderer, /fetchJson\("\/api\/v1\/runs"\)/);
  assert.match(renderer, /\/api\/v1\/runs\/" \+ encodeURIComponent\(match\[1\]\) \+ "\/replay"/);
  assert.doesNotMatch(renderer, /\.innerHTML\b|\beval\s*\(|new Function\b/);
});
