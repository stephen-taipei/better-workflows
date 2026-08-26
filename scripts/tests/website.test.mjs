import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "../..");
const buildScript = path.join(repoRoot, "scripts", "build-website.mjs");

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function relativeTargets(content) {
  return [...content.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((target) => !target.startsWith("#") && !target.startsWith("/") && !target.startsWith("http") && !target.startsWith("data:") && !target.includes("${"))
    .map((target) => target.split("#", 1)[0].split("?", 1)[0]);
}

test("official website build is self-contained and includes docs/html", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "better-workflows-site-"));
  const outputDirectory = path.join(temporaryRoot, "website");
  try {
    await execFileAsync(process.execPath, [buildScript], {
      cwd: repoRoot,
      env: { ...process.env, SITE_OUTPUT_DIR: outputDirectory, SOURCE_DATE_EPOCH: "1756080000" }
    });

    const landing = await readFile(path.join(outputDirectory, "index.html"), "utf8");
    const release = JSON.parse(await readFile(path.join(outputDirectory, "release.json"), "utf8"));
    assert.doesNotMatch(landing, /__SITE_/);
    assert.match(landing, /https:\/\/betterworkflows\.dev\//);
    assert.match(landing, /href="\/docs\/"/);
    assert.equal(release.project, "better-workflows");
    assert.deepEqual(release.domains, ["betterworkflows.dev", "betterworkflows.org"]);
    assert.equal(release.repository, "https://github.com/stephen-taipei/better-workflows");
    assert.equal(release.locales, 41);
    assert.equal(release.defaultLocale, "zh-Hant-TW");
    assert.match(release.assetVersion, /^[a-f0-9]{12}$/);
    assert.match(release.contentDigest, /^[a-f0-9]{64}$/);
    assert.match(landing, new RegExp(`/styles\\.css\\?v=${release.assetVersion}`));
    assert.match(landing, new RegExp(`/site\\.js\\?v=${release.assetVersion}`));
    assert.equal(await readFile(path.join(outputDirectory, "healthz"), "utf8"), "ok\n");

    for (const relativePath of [
      "docs/index.html",
      "docs/preview.html",
      "docs/evidence-cinema/index.html",
      "docs/evidence-cinema/assets/scene-01-goal.webp",
      "docs/use-cases/index.html",
      "docs/use-cases/preview.html",
      "en/index.html",
      "zh-Hant-HK/index.html",
      "locales.json",
      "plugins/better-workflows/skills/better-workflows/references/evidence-and-state.md"
    ]) assert.equal(await exists(path.join(outputDirectory, relativePath)), true, relativePath);

    for (const htmlPath of [
      path.join(outputDirectory, "index.html"),
      path.join(outputDirectory, "docs", "index.html"),
      path.join(outputDirectory, "docs", "preview.html"),
      path.join(outputDirectory, "docs", "evidence-cinema", "index.html"),
      path.join(outputDirectory, "docs", "use-cases", "index.html"),
      path.join(outputDirectory, "docs", "use-cases", "preview.html"),
      path.join(outputDirectory, "en", "index.html")
    ]) {
      const html = await readFile(htmlPath, "utf8");
      for (const target of relativeTargets(html)) {
        if (!target || target.startsWith("javascript:")) continue;
        assert.equal(await exists(path.resolve(path.dirname(htmlPath), target)), true, `${htmlPath}: ${target}`);
      }
    }

    const outputStats = await stat(outputDirectory);
    assert.equal(outputStats.isDirectory(), true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
