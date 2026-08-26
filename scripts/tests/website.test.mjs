import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "../..");

function runBuild(environment) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "scripts", "build-website.mjs")], {
      cwd: repoRoot,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("website build refuses an output path outside dist or temporary roots", async () => {
  const result = await runBuild({ SITE_OUTPUT_DIR: repoRoot });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /SITE_OUTPUT_DIR must be a child/);
  assert.equal((await readFile(path.join(repoRoot, "README.md"), "utf8")).includes("Better Workflows"), true);
});
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

function contrastRatio(left, right) {
  const luminance = (hex) => {
    const channels = hex.match(/[a-f0-9]{2}/gi).map((value) => parseInt(value, 16) / 255);
    const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
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
    assert.equal(release.sponsorUrl, "https://ko-fi.com/betterworkflows");
    assert.equal(release.sponsorMode, "one-time-only");
    assert.equal(release.locales, 41);
    assert.equal(release.defaultLocale, "zh-Hant-TW");
    assert.match(release.assetVersion, /^[a-f0-9]{12}$/);
    assert.match(release.contentDigest, /^[a-f0-9]{64}$/);
    assert.match(landing, new RegExp(`/styles\\.css\\?v=${release.assetVersion}`));
    assert.match(landing, new RegExp(`/site\\.js\\?v=${release.assetVersion}`));
    assert.match(landing, /href="https:\/\/ko-fi\.com\/betterworkflows" target="_blank" rel="noopener noreferrer"/);
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
      "manifest.directories",
      "manifest.sha256",
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

test("GitHub funding configuration exposes only the verified Ko-fi account", async () => {
  const funding = await readFile(path.join(repoRoot, ".github", "FUNDING.yml"), "utf8");
  assert.equal(funding, "ko_fi: betterworkflows\n");
});

test("Ko-fi CTA contrast and responsive navigation satisfy accessibility bounds", async () => {
  const styles = await readFile(path.join(repoRoot, "website", "styles.css"), "utf8");
  const backgrounds = [...styles.matchAll(/\.button-kofi[^\{]*\{[^}]*background:\s*(#[a-f0-9]{6})/gi)].map((match) => match[1]);
  assert.equal(backgrounds.length, 2);
  for (const background of backgrounds) assert.ok(contrastRatio(background, "#ffffff") >= 4.5, background);
  assert.match(styles, /@media \(max-width: 1080px\)[^{]*\{[^}]*\.header-inner/);
});
