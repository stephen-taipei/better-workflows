import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONNECTORS_LOCALES, DEFAULT_LOCALE, PUBLIC_RC1_LOCALE_IDS, locales } from "../website-locales.mjs";
import { scanHtml } from "../html-source.mjs";
import { publicTextPath } from "../policy-routes.mjs";
import { PUBLIC_DOC_PAGES, publicDocPath } from "../public-docs.mjs";

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
  assert.match(result.stderr, /must not replace or delete repository content outside canonical dist/);
  assert.equal((await readFile(path.join(repoRoot, "README.md"), "utf8")).includes("Better Workflows"), true);
});

test("website build explicitly rejects repository content outside canonical dist", async () => {
  const source = await readFile(path.join(repoRoot, "scripts", "build-website.mjs"), "utf8");
  assert.match(source, /candidateInsideRepository && !candidateInsideAuthorizedDist/);
  assert.match(source, /must not replace or delete repository content outside canonical dist/);
});

test("website build refuses a repository dist symlink that escapes the checkout", async () => {
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "better-workflows-external-dist-"));
  const distPath = path.join(repoRoot, "dist");
  assert.equal(await exists(distPath), false, "dist must be absent before the symlink boundary test");
  try {
    await symlink(externalRoot, distPath);
    const result = await runBuild({ SITE_OUTPUT_DIR: path.join(distPath, "website") });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /must not traverse a symlinked repository dist/);
  } finally {
    await rm(distPath, { force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});
const buildScript = path.join(repoRoot, "scripts", "build-website.mjs");

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
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

async function verifyBuiltSiteWithPublicQaFixture(temporaryRoot, outputDirectory, revision) {
  const preload = path.join(temporaryRoot, "public-qa-local-fetch.mjs");
  const stateRoot = path.join(temporaryRoot, "public-qa-local-state");
  // Execute the unmodified production CLI, but replace fetch in this child
  // before imports. No request can leave this test's generated artifact.
  await writeFile(preload, `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
const artifact = ${JSON.stringify(outputDirectory)};
globalThis.fetch = async (url, options) => {
  const target = new URL(url);
  assert.equal(target.origin, "https://betterworkflows.dev");
  assert.equal(target.searchParams.get("sbw_revision"), ${JSON.stringify(revision)});
  assert.equal(options.redirect, "error");
  const relative = target.pathname.endsWith("/") ? target.pathname.slice(1) + "index.html" : target.pathname.slice(1);
  const file = path.resolve(artifact, relative);
  assert.ok(file.startsWith(artifact + path.sep), "fixture request escaped artifact");
  const contentType = file.endsWith(".json") ? "application/json" : file.endsWith(".html") ? "text/html" : "text/plain";
  return new Response(await readFile(file), { status: 200, headers: { "content-type": contentType } });
};
`, { flag: "wx" });
  const { stdout } = await execFileAsync(process.execPath, ["--import", preload, path.join(repoRoot, "scripts/website-public-qa.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, SBW_STATE_ROOT: stateRoot, SBW_RELEASE_REVISION: revision },
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024
  });
  const summary = JSON.parse(stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.outputPath, path.join(stateRoot, "release-gates", revision, "website-public-qa.json"));
  const receipt = JSON.parse(await readFile(summary.outputPath, "utf8"));
  assert.equal(receipt.sourceRevision, revision);
  assert.equal(receipt.result, "PASS");
  assert.equal(receipt.locales.length, PUBLIC_RC1_LOCALE_IDS.length);
  assert.equal(receipt.publicDocumentationPages, 5);
  assert.equal(receipt.publicDocumentationRoutes.length, PUBLIC_RC1_LOCALE_IDS.length * PUBLIC_DOC_PAGES.length);
  assert.ok(receipt.publicDocumentationRoutes.every((entry) => entry.result === "PASS"));
  assert.equal(receipt.authentication.status, "awaiting-github-oidc-attestation");
  assert.equal(receipt.authentication.releaseEligible, false);
}

test("official website build serves Auto-only public docs without archived template assets", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "better-workflows-site-"));
  const outputDirectory = path.join(temporaryRoot, "website");
  try {
    await execFileAsync(process.execPath, [buildScript], {
      cwd: repoRoot,
      env: { ...process.env, SITE_OUTPUT_DIR: outputDirectory, SOURCE_DATE_EPOCH: "1756080000" }
    });

    const landing = await readFile(path.join(outputDirectory, "index.html"), "utf8");
    const englishHomepage = await readFile(path.join(outputDirectory, "en", "index.html"), "utf8");
    const release = JSON.parse(await readFile(path.join(outputDirectory, "release.json"), "utf8"));
    assert.doesNotMatch(landing, /__SITE_/);
    assert.match(landing, /https:\/\/betterworkflows\.dev\//);
    assert.match(landing, /href="\/docs\/"/);
    assert.equal(release.project, "better-workflows");
    assert.deepEqual(release.domains, ["betterworkflows.dev", "betterworkflows.org"]);
    assert.equal(release.repository, "https://github.com/stephen-taipei/better-workflows");
    assert.equal(release.sponsorUrl, "https://betterworkflows.dev/#sponsor");
    assert.equal(release.sponsorMode, "one-time-only");
    assert.equal(release.sponsorCurrency, "USDT");
    assert.equal(release.sponsorNetwork, "TRC20");
    assert.equal(release.sponsorAddress, "TGuMUi1d8MoBQcuFrGJZnu4JrbaeP3wy9a");
    assert.equal(release.sponsorQrPath, "/docs/assets/sponsor-usdt-trc20.jpeg");
    assert.equal(release.sponsorQrSha256, "ef7c46831b0992d69ce5c89883ea61b5f98807df9d0a071556a6f2615436910e");
    assert.equal(release.locales, PUBLIC_RC1_LOCALE_IDS.length);
    assert.equal(release.publicDocumentationPages, 5);
    assert.equal(release.localizedReferencePages, PUBLIC_RC1_LOCALE_IDS.length * PUBLIC_DOC_PAGES.length);
    assert.equal(release.defaultLocale, "zh-Hant-TW");
    assert.equal(release.hostRegistryId, "host-support-v1");
    assert.match(release.hostRegistryDigest, /^[a-f0-9]{64}$/);
    assert.match(release.revision, /^[a-f0-9]{40}$/);
    assert.match(release.assetVersion, /^[a-f0-9]{12}$/);
    assert.match(release.contentDigest, /^[a-f0-9]{64}$/);
    const canonicalLogo = await readFile(path.join(repoRoot, "docs", "html", "assets", "better-workflows-mark.svg"), "utf8");
    assert.equal(await readFile(path.join(outputDirectory, "better-workflows-mark.svg"), "utf8"), canonicalLogo, "better-workflows-mark.svg: exact approved source asset");
    // The tab icon is the same approved Converge geometry on a square canvas, so it stays centred and legible at 16px.
    const logoGeometry = (svg) => svg.match(/<path\b[^>]*\sd="([^"]+)"/)?.[1];
    const logoFill = (svg) => svg.match(/<path\b[^>]*\sfill="([^"]+)"/)?.[1];
    const favicon = await readFile(path.join(outputDirectory, "favicon.svg"), "utf8");
    assert.ok(logoGeometry(canonicalLogo), "canonical logo has path geometry");
    assert.equal(logoGeometry(favicon), logoGeometry(canonicalLogo), "favicon.svg: exact approved Converge geometry");
    assert.equal(logoFill(favicon), logoFill(canonicalLogo), "favicon.svg: approved brand orange");
    const [, , faviconWidth, faviconHeight] = favicon.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
    assert.equal(faviconWidth, faviconHeight, "favicon.svg: square canvas");
    const iconHeader = (await readFile(path.join(outputDirectory, "favicon.ico"))).subarray(0, 6);
    assert.deepEqual([...iconHeader.subarray(0, 4)], [0, 0, 1, 0], "favicon.ico: ICO container for browsers without SVG icon support");
    const touchIcon = await readFile(path.join(outputDirectory, "apple-touch-icon.png"));
    assert.equal(touchIcon.subarray(1, 4).toString("latin1"), "PNG", "apple-touch-icon.png: PNG");
    assert.equal(touchIcon.readUInt32BE(16), 180);
    assert.equal(touchIcon.readUInt32BE(20), 180);
    for (const code of PUBLIC_RC1_LOCALE_IDS) {
      const home = await readFile(path.join(outputDirectory, ...(code === DEFAULT_LOCALE ? [] : [code]), "index.html"), "utf8");
      assert.match(home, new RegExp(`<link rel="icon" href="/favicon\\.svg\\?v=${release.assetVersion}" type="image/svg\\+xml"`), `${code}: content-bound SVG icon`);
      assert.match(home, new RegExp(`<link rel="apple-touch-icon" href="/apple-touch-icon\\.png\\?v=${release.assetVersion}">`), `${code}: content-bound touch icon`);
      assert.equal((home.match(/rel="icon"/g) || []).length, 2, `${code}: exactly the .ico and .svg icons`);
    }
    const englishV5Title = locales.find((locale) => locale.code === "en").v5Product.title;
    for (const code of PUBLIC_RC1_LOCALE_IDS) {
      const homepage = path.join(outputDirectory, ...(code === DEFAULT_LOCALE ? [] : [code]), "index.html");
      const body = await readFile(homepage, "utf8");
      const marks = [...body.matchAll(/<img class="brand-mark brand-mark--converge"[^>]*>/g)];
      assert.equal(marks.length, 2, `${code}: header and footer brand marks`);
      for (const [mark] of marks) {
        assert.ok(mark.includes(`src="/better-workflows-mark.svg?v=${release.assetVersion}"`), `${code}: content-bound asset`);
        assert.match(mark, /width="34" height="27" alt="" aria-hidden="true"/, `${code}: stable decorative image layout matching the 756:608 mark`);
      }
      const v5Status = body.match(/<section class="section shell v5-status-section" id="v5-status">([\s\S]*?)<\/section>/)?.[1] || "";
      assert.ok(v5Status.trim(), `${code}: V5 product status must be rendered`);
      assert.match(body, /V4 · HOST-SUPPORT-V1/, `${code}: historical host matrix version`);
      assert.match(v5Status, /V5/);
      const scope = locales.find((locale) => locale.code === code).v5Product.scope;
      assert.ok(v5Status.includes(`<p>${escapeHtml(scope)}</p>`), `${code}: exact localized V5 platform scope`);
      assert.match(v5Status, /AGPL-3\.0-only/);
      assert.match(v5Status, /Apache-2\.0/);
      assert.match(v5Status, /Professional Pack/);
      assert.match(v5Status, /Cloud/);
      assert.doesNotMatch(v5Status, /isolated environment|隔離環境安全完成/);
      assert.equal(v5Status.includes(englishV5Title), code === "en", `${code}: V5 copy must not fall back to English`);
    }
    assert.ok(release.sourceModifiedAt && !Number.isNaN(Date.parse(release.sourceModifiedAt)));
    assert.match(landing, new RegExp(`/styles\\.css\\?v=${release.assetVersion}`));
    assert.match(landing, new RegExp(`/site\\.js\\?v=${release.assetVersion}`));
    assert.match(landing, /證據至上的 AI 工程 QA/);
    assert.match(landing, /官方推薦：macOS \+ Codex/);
    assert.match(landing, /class="support-matrix"/);
    assert.match(landing, /class="capability-matrix"/);
    assert.match(landing, /Replay 是重播/);
    for (const [label, html] of [["default", landing]]) {
      assert.match(html, /<section class="section shell v5-status-section" id="v5-status">[\s\S]*V5.0 RC1 已公開上架，GA 仍待完成。/,
        `${label}: canonical V5 status must survive homepage rendering`);
      assert.match(html, /AGPL-3\.0-only/);
      assert.match(html, /Apache-2\.0/);
      assert.match(html, /Professional Pack/);
      assert.match(html, /Cloud/);
      assert.match(html, /V4 支援矩陣仍屬歷史文件範圍/);
    }
    const englishStatus = englishHomepage.match(/<section class="section shell v5-status-section" id="v5-status">([\s\S]*?)<\/section>/)?.[1] || "";
    assert.match(englishStatus, /V5\.0 RC1 is publicly available\. GA remains pending\./,
      "English must receive the complete localized V5 product copy");
    assert.match(landing, /href="\/docs\/assets\/sponsor-usdt-trc20\.jpeg\?sha256=ef7c46831b0992d69ce5c89883ea61b5f98807df9d0a071556a6f2615436910e" target="_blank" rel="noopener noreferrer"/);
    assert.match(landing, /class="sponsor-address" dir="ltr">TGuMUi1d8MoBQcuFrGJZnu4JrbaeP3wy9a<\/code>/);
    assert.doesNotMatch(landing, new RegExp(["ko", "fi"].join("[-_]"), "i"));
    assert.equal(await readFile(path.join(outputDirectory, "healthz"), "utf8"), "ok\n");

    const defaultDocs = await readFile(path.join(outputDirectory, "docs", "index.html"), "utf8");
    assert.match(defaultDocs, /<h1>從這裡開始<\/h1>/);
    assert.match(defaultDocs, /read-only-v1/);
    assert.match(defaultDocs, /code-change-v1/);
    assert.match(defaultDocs, /dev-publish-v1/);
    assert.doesNotMatch(defaultDocs, /pr-to-main|pr-to-dev-agent-quorum|self-improve-ops|review-to-issues/);
    assert.match(defaultDocs, /<link rel="canonical" href="https:\/\/betterworkflows\.dev\/docs\/">/);
    assert.doesNotMatch(defaultDocs, /<iframe|data-reference-coverage/);
    assert.doesNotMatch(defaultDocs, /TechArticle/);
    assert.deepEqual((await readdir(path.join(outputDirectory, "docs", "reference", "use-cases"))).sort(), ["index.html", "preview.html"]);
    assert.match(await readFile(path.join(outputDirectory, "en", "index.html"), "utf8"), /<a class="brand" href="\/en\/"/);

    for (const relativePath of [
      "docs/index.html",
      "docs/quick/index.html",
      "docs/preview.html",
      "docs/evidence-cinema/index.html",
      "docs/evidence-cinema/assets/scene-01-goal.webp",
      "docs/evidence-cinema/shared/cinema.css",
      "docs/reference/index.html",
      "docs/reference/zh-Hant-TW/index.html",
      "docs/reference/en/use-cases/index.html",
      "docs/reference/reference-locales.js",
      "docs/use-cases/index.html",
      "docs/use-cases/quick/index.html",
      "docs/use-cases/preview.html",
      "en/index.html",
      "en/docs/index.html",
      "en/docs/evidence-cinema/index.html",
      "en/docs/use-cases/index.html",
      "locales.json",
      "manifest.directories",
      "manifest.sha256",
      "plugins/better-workflows/skills/auto/SKILL.md"
    ]) assert.equal(await exists(path.join(outputDirectory, relativePath)), true, relativePath);

    for (const code of CONNECTORS_LOCALES.filter((item) => !PUBLIC_RC1_LOCALE_IDS.includes(item))) {
      assert.equal(await exists(path.join(outputDirectory, code, "index.html")), false, `${code}: deferred homepage`);
      assert.equal(await exists(path.join(outputDirectory, code, "docs", "index.html")), false, `${code}: deferred documentation`);
    }

    for (const relativePath of [
      "docs/evidence-cinema/shared/renderer.js",
      "docs/evidence-cinema/shared/public-locales.js",
      "docs/evidence-cinema/imagegen-manifest.md",
      "docs/reference/evidence-cinema/assets/scene-01-goal.webp"
    ]) assert.equal(await exists(path.join(outputDirectory, relativePath)), false, relativePath);

    assert.deepEqual(
      await readdir(path.join(outputDirectory, "plugins", "better-workflows", "templates")),
      ["auto.json"],
      "the website artifact must contain only the public Auto template"
    );
    assert.deepEqual(
      await readdir(path.join(outputDirectory, "plugins", "better-workflows", "skills")),
      ["auto"],
      "the website artifact must contain only the public Auto skill"
    );
    const pluginManifest = JSON.parse(await readFile(path.join(
      outputDirectory, "plugins", "better-workflows", ".codex-plugin", "plugin.json"
    ), "utf8"));
    const sourcePluginManifest = JSON.parse(await readFile(path.join(
      repoRoot, "plugins", "better-workflows", ".codex-plugin", "plugin.json"
    ), "utf8"));
    assert.equal(pluginManifest.version, sourcePluginManifest.version);
    assert.match(
      await readFile(path.join(outputDirectory, "docs", "evidence-cinema", "index.html"), "utf8"),
      /V5.0 RC1 已公開/
    );

    for (const relativePath of ["docs/index.html", "docs/use-cases/index.html"]) {
      const html = await readFile(path.join(outputDirectory, relativePath), "utf8");
      assert.match(html, /href="\/docs\/evidence-cinema\/"/);
    }

    for (const htmlPath of [
      path.join(outputDirectory, "index.html"),
      path.join(outputDirectory, "docs", "index.html"),
      path.join(outputDirectory, "docs", "quick", "index.html"),
      path.join(outputDirectory, "docs", "preview.html"),
      path.join(outputDirectory, "docs", "evidence-cinema", "index.html"),
      path.join(outputDirectory, "docs", "reference", "index.html"),
      path.join(outputDirectory, "docs", "use-cases", "index.html"),
      path.join(outputDirectory, "docs", "use-cases", "quick", "index.html"),
      path.join(outputDirectory, "docs", "use-cases", "preview.html"),
      path.join(outputDirectory, "en", "index.html"),
      path.join(outputDirectory, "en", "docs", "index.html"),
      path.join(outputDirectory, "en", "docs", "use-cases", "index.html")
    ]) {
      const html = await readFile(htmlPath, "utf8");
      for (const target of relativeTargets(html)) {
        if (!target || target.startsWith("javascript:")) continue;
        assert.equal(await exists(path.resolve(path.dirname(htmlPath), target)), true, `${htmlPath}: ${target}`);
      }
    }

    for (const [relativePath, defaultRoute] of [
      ["docs/preview.html", "/docs/quick/"],
      ["docs/use-cases/preview.html", "/docs/use-cases/quick/"]
    ]) {
      const html = await readFile(path.join(outputDirectory, relativePath), "utf8");
      const buttons = [...html.matchAll(/data-locale-button="([^\"]+)"[^>]+href="([^\"]+)"/g)];
      assert.deepEqual(buttons.map(([, code]) => code), PUBLIC_RC1_LOCALE_IDS, `${relativePath}: redirect locale buttons`);
      assert.deepEqual(
        buttons.map(([, , href]) => href),
        PUBLIC_RC1_LOCALE_IDS.map((code) => code === DEFAULT_LOCALE ? defaultRoute : `/${code}${defaultRoute}`),
        `${relativePath}: redirect locale routes`
      );
    }

    for (const [relativePath, pageId] of [
      ["docs/reference/index.html", "guide"],
      ["docs/reference/zh-Hant-TW/index.html", "guide"],
      ["docs/reference/en/use-cases/index.html", "use-cases"]
    ]) {
      const html = await readFile(path.join(outputDirectory, relativePath), "utf8");
      const switcher = html.match(/<nav class="locale-button-grid"[\s\S]*?<\/nav>/)?.[0] || "";
      const buttons = [...switcher.matchAll(/data-locale-button="([^\"]+)"[^>]+href="([^\"]+)"/g)];
      assert.deepEqual(buttons.map(([, code]) => code), PUBLIC_RC1_LOCALE_IDS, `${relativePath}: reference locale buttons`);
      assert.deepEqual(
        buttons.map(([, , href]) => href),
        PUBLIC_RC1_LOCALE_IDS.map((code) => publicDocPath(code, pageId)),
        `${relativePath}: reference locale routes`
      );
      assert.match(html, /data-public-locale-buttons/);
      assert.doesNotMatch(html, /<iframe|data-bw-localized-reference/);
    }

    const visitableRoutes = ["/", "/en/", "/support/", "/en/support/", "/404.html",
      ...PUBLIC_RC1_LOCALE_IDS.flatMap(code => PUBLIC_DOC_PAGES.map(page => publicDocPath(code,page.id))),
      ...PUBLIC_RC1_LOCALE_IDS.flatMap(code => ["security","contributing","governance","conduct","getting-started","workflows","architecture","security-guide","cli-reference"].map(id => publicTextPath(code,id)))];
    for (const route of visitableRoutes) {
      const html = await readFile(path.join(outputDirectory, route === "/404.html" ? "404.html" : route.slice(1)+"index.html"), "utf8");
      const nodes = scanHtml(html).elements;
      if (/<meta http-equiv="refresh"/.test(html)) {
        assert.ok(/\/guides\/(architecture|security-guide|cli-reference)\/$/.test(route),route+": only documented retired routes may redirect here");
        assert.match(html, /<meta name="robots" content="noindex,follow">/);
        assert.equal(nodes.filter(n => Object.hasOwn(n.attributes,"data-locale-button")).length,PUBLIC_RC1_LOCALE_IDS.length,route+": redirect keeps every locale route");
        continue;
      }
      assert.equal(nodes.filter(n => n.tag === "header" && n.attributes.class === "site-header").length,1, route+": shared header");
      assert.equal(nodes.filter(n => n.tag === "main").length,1, route+": one main landmark");
      assert.equal(nodes.filter(n => n.tag === "h1").length,1, route+": one primary heading");
      assert.equal(nodes.filter(n => Object.hasOwn(n.attributes,"data-theme-toggle")).length,1, route+": one theme control");
      const language = nodes.filter(n => n.tag === "nav" && n.attributes.class === "lang" && Object.hasOwn(n.attributes,"data-public-locale-buttons"));
      assert.equal(language.length,1, route+": one language control");
      assert.equal(nodes.filter(n => n.tag === "details" && n.attributes.class === "locale-menu").length,0, route+": no legacy language dropdown");
      assert.equal(nodes.filter(n => n.tag === "select").filter(n => /locale/i.test(n.attributes.id||"")).length,0, route+": no duplicate locale selector");
      const ids=nodes.map(n=>n.attributes.id).filter(Boolean);
      assert.equal(new Set(ids).size,ids.length, route+": unique IDs");
      const segment=route.split("/")[1], home=PUBLIC_RC1_LOCALE_IDS.includes(segment) && segment !== DEFAULT_LOCALE ? `/${segment}/` : "/";
      for (const anchor of ["product","workflow","install","principles"]) assert.ok(html.includes(`href="${home}#${anchor}"`),route+": homepage navigation "+anchor);
      const menuLinks=nodes.filter(n=>Object.hasOwn(n.attributes,"data-locale-button"));
      assert.equal(menuLinks.length,PUBLIC_RC1_LOCALE_IDS.length,route+": every locale link works without scripts");
      assert.doesNotMatch(html,/<iframe\b/);
    }
    const pageBodies=await Promise.all(["docs/index.html","docs/quick/index.html","docs/use-cases/index.html","docs/use-cases/quick/index.html"].map(file=>readFile(path.join(outputDirectory,file),"utf8")));
    assert.equal(new Set(pageBodies.map(html=>html.match(/<article class="document-content">([\s\S]*?)<\/article>/)?.[1])).size,4,"four documentation pages have distinct content");
    const outputStats = await stat(outputDirectory);
    assert.equal(outputStats.isDirectory(), true);
    await verifyBuiltSiteWithPublicQaFixture(temporaryRoot, outputDirectory, release.revision);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("GitHub funding exposes only the owner-selected USDT sponsorship page", async () => {
  const funding = await readFile(path.join(repoRoot, ".github", "FUNDING.yml"), "utf8");
  assert.equal(funding, 'custom: ["https://betterworkflows.dev/#sponsor"]\n');
});

test("sponsorship address and responsive navigation remain readable", async () => {
  const styles = await readFile(path.join(repoRoot, "website", "styles.css"), "utf8");
  assert.match(styles, /\.sponsor-address\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*direction:\s*ltr;[^}]*user-select:\s*all;/);
  assert.match(styles, /\.sponsor-qr\s*\{[^}]*background:\s*#fff;/);
  assert.match(styles, /@media\s*\(max-width:\s*1100px\)[^{]*\{[^}]*\.header-inner/);
});
