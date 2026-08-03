import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pluginRoot, VERSION } from "../lib/core.mjs";

const repoRoot = path.resolve(pluginRoot(), "../..");
const overview = path.join(repoRoot, "README.md");
const localizedDocuments = [
  {
    overview: path.join(repoRoot, "docs", "README.zh-TW.md"),
    details: path.join(repoRoot, "docs", "details", "zh-TW.md")
  },
  {
    overview: path.join(repoRoot, "docs", "README.zh-CN.md"),
    details: path.join(repoRoot, "docs", "details", "zh-CN.md")
  },
  {
    overview: path.join(repoRoot, "docs", "README.ja.md"),
    details: path.join(repoRoot, "docs", "details", "ja.md")
  },
  {
    overview: path.join(repoRoot, "docs", "README.ko.md"),
    details: path.join(repoRoot, "docs", "details", "ko.md")
  }
];
const guideDocuments = [
  path.join(repoRoot, "docs", "details", "en.md"),
  path.join(repoRoot, "docs", "guide", "getting-started.md"),
  path.join(repoRoot, "docs", "guide", "workflows.md"),
  path.join(repoRoot, "docs", "guide", "architecture.md"),
  path.join(repoRoot, "docs", "guide", "security.md"),
  path.join(repoRoot, "docs", "guide", "cli-reference.md")
];

function assertDetailedCoverage(content, file) {
  assert.match(content, /sbw doctor --capabilities/, file);
  assert.match(content, /sbw route preview/, file);
  assert.match(content, /sbw route profile validate/, file);
  assert.match(content, /sbw run --route-receipt/, file);
  assert.match(content, /plugin-cache\.mjs check/, file);
  assert.match(content, /immutable/, file);
  assert.match(content, /pr-to-dev/, file);
  assert.match(content, /\$better-workflows:self-improve/, file);
  assert.match(content, /train\/holdout/, file);
  assert.match(content, /host-signed/, file);
  assert.match(content, /Evaluation v2\.2/, file);
  assert.match(content, /\$better-workflows:workspace-recipe/, file);
  assert.match(content, /self-improve host status/, file);
  assert.match(content, /self-improve attestation request/, file);
  assert.match(content, /recipe scaffold json-keyset-audit/, file);
  assert.match(content, /recipe promote <id>/, file);
  assert.match(content, /artifact\.promote/, file);
  assert.match(content, /graph validate/, file);
  assert.match(content, /graph inspect/, file);
  assert.match(content, /Dynamic\s+Workflow[\s\S]{0,20}runtime/, file);
  assert.match(content, /policy\s+input/, file);
  assert.match(content, /authority\s+source/, file);
  assert.match(content, /agent\s+runtime/, file);
  assert.match(content, /graph envelope/, file);
  assert.match(content, /presentation/, file);
  assert.match(content, /non-sensitive\s+structural[\s\S]{0,20}projection/, file);
  assert.match(content, /exit `2`/, file);
}

function capabilityTableRows(content, file) {
  const lines = content.split("\n");
  const headerIndex = lines.findIndex((line) => /^\| Primitive \| [^|]+ \| [^|]+ \|$/.test(line));
  assert.notEqual(headerIndex, -1, `${file}: capability table header`);
  const table = lines.slice(headerIndex, headerIndex + 7);
  assert.equal(table[1], "| --- | --- | --- |", `${file}: capability table separator`);
  assert.deepEqual(
    table.slice(2).map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()).length),
    [3, 3, 3, 3, 3],
    `${file}: every capability row has exactly three columns`
  );
  const rows = table.slice(2).map((line) => {
    const [primitive, purpose, boundary] = line.split("|").slice(1, -1).map((cell) => cell.trim());
    assert.ok(purpose, `${file}: capability purpose is not empty`);
    assert.ok(boundary, `${file}: capability boundary is not empty`);
    return { primitive, boundary };
  });
  assert.deepEqual(
    rows.map((row) => row.primitive),
    ["**Prompt**", "**Context**", "**Harness**", "**Loop**", "**Graph**"],
    `${file}: capability rows are complete and ordered`
  );
  assert.doesNotMatch(
    lines[headerIndex + 7] ?? "",
    /^\| [^|]+ \| [^|]+ \| [^|]+ \|$/,
    `${file}: capability table has exactly five rows`
  );
  return rows;
}

test("English README is concise, visual, and routes details into focused guides", async (context) => {
  try {
    await access(overview);
  } catch {
    context.skip("repository README files are not part of the installed plugin cache bundle");
    return;
  }

  const content = await readFile(overview, "utf8");
  assert.ok(content.split("\n").length <= 200, "README should remain under 200 lines");
  assert.match(content, /better-workflows-engineering-stack\.svg/);
  assert.match(content, /\| Item \| \*\*Prompt\*\* \| \*\*Context\*\* \| \*\*Harness\*\* \| \*\*Loop\*\* \| \*\*Graph\*\* \|/);
  for (const brand of ["Codex", "Claude", "Gemini", "GPT-OSS", "Grok", "Cursor", "Kimi", "Qwen", "Kiro"]) {
    assert.match(content, new RegExp(brand), `README model roster: ${brand}`);
  }
  assert.match(content, /agy` is transport metadata, not\s+another model brand/);
  for (const name of [
    "getting-started.md",
    "workflows.md",
    "architecture.md",
    "security.md",
    "cli-reference.md",
    "details/en.md"
  ]) {
    assert.match(content, new RegExp(name.replace(".", "\\.")), name);
  }
});

test("every localized README is a concise visual overview with a same-language details page", async (context) => {
  try {
    await access(overview);
  } catch {
    context.skip("repository README files are not part of the installed plugin cache bundle");
    return;
  }
  for (const document of localizedDocuments) {
    const content = await readFile(document.overview, "utf8");
    assert.ok(
      content.split("\n").length <= 200,
      `${document.overview} should remain under 200 lines`
    );
    assert.match(content, /better-workflows-engineering-stack\.svg/, document.overview);
    for (const layer of ["Prompt", "Context", "Harness", "Loop", "Graph"]) {
      assert.match(content, new RegExp(`\\*\\*${layer}\\*\\*`), `${document.overview}: ${layer}`);
    }
    assert.match(
      content,
      new RegExp(`details/${path.basename(document.details).replace(".", "\\.")}`),
      document.overview
    );
    for (const brand of ["Codex", "Claude", "Gemini", "GPT-OSS", "Grok", "Cursor", "Kimi", "Qwen", "Kiro"]) {
      assert.match(content, new RegExp(brand), `${document.overview}: ${brand}`);
    }
  }
});

test("all five README version badges match the runtime semantic version", async (context) => {
  try {
    await access(overview);
  } catch {
    context.skip("repository README files are not part of the installed plugin cache bundle");
    return;
  }
  for (const file of [overview, ...localizedDocuments.map((item) => item.overview)]) {
    const escapedVersion = VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(await readFile(file, "utf8"), new RegExp(`version-${escapedVersion}-`), file);
  }
});

test("all five README entry pages expose the explicit capability map as an accessible table", async (context) => {
  try {
    await access(overview);
  } catch {
    context.skip("repository README files are not part of the installed plugin cache bundle");
    return;
  }
  for (const file of [overview, ...localizedDocuments.map((item) => item.overview)]) {
    const content = await readFile(file, "utf8");
    const rows = capabilityTableRows(content, file);
    assert.match(rows[0].boundary, /authority|權限|权限|権限|권한/, `${file}: Prompt authority boundary`);
    assert.match(rows[1].boundary, /digest/i, `${file}: Context digest boundary`);
    assert.match(rows[2].boundary, /trust|信任|信頼|신뢰/i, `${file}: Harness trust boundary`);
    assert.match(rows[3].boundary, /retry|重試|重试/i, `${file}: Loop retry boundary`);
    assert.match(rows[4].boundary, /scheduler/, `${file}: Graph scheduler boundary`);
    assert.match(rows[4].boundary, /authorization|授權|授权|権限|권한/, `${file}: Graph authorization boundary`);
    const graphRowEnd = content.indexOf("\n", content.indexOf("| **Graph** |"));
    const rejectionMarker = "REJECTED_WITH_EVIDENCE";
    const rejectionEnd = content.indexOf(rejectionMarker) + rejectionMarker.length;
    assert.ok(rejectionEnd >= rejectionMarker.length, `${file}: redacted rejection boundary`);
    assert.ok(
      Buffer.byteLength(content.slice(0, Math.max(graphRowEnd, rejectionEnd)), "utf8") <= 900,
      `${file}: capability and rejection evidence fit the bounded sanitizer prefix`
    );
  }
});

test("split English guides preserve the complete detailed contract", async (context) => {
  try {
    await access(overview);
  } catch {
    context.skip("repository guide files are not part of the installed plugin cache bundle");
    return;
  }
  const content = (
    await Promise.all([overview, ...guideDocuments].map((file) => readFile(file, "utf8")))
  ).join("\n");
  assertDetailedCoverage(content, "English overview and guides");
  assert.match(content, /Antigravity CLI \(`agy`\)/);
  assert.match(content, /transport[\s\S]{0,80}not a second model brand/);
});

test("localized details pages preserve complete detailed coverage", async (context) => {
  try {
    await access(overview);
  } catch {
    context.skip("repository README files are not part of the installed plugin cache bundle");
    return;
  }
  for (const document of localizedDocuments) {
    const content = await readFile(document.details, "utf8");
    assertDetailedCoverage(content, document.details);
    assert.doesNotMatch(content, /Gemini[（(](?:經|经|Agy 経由|Agy 경유).*Agy.*Grok/);
  }
});

test("provider, reservation, and deferred-action rules stay synchronized across docs", async (context) => {
  try {
    await access(overview);
  } catch {
    context.skip("repository docs are not part of the installed plugin cache bundle");
    return;
  }
  const files = [
    path.join(repoRoot, "docs", "details", "en.md"),
    ...localizedDocuments.map((item) => item.details),
    path.join(repoRoot, "docs", "guide", "security.md"),
    path.join(repoRoot, "docs", "guide", "cli-reference.md"),
    path.join(pluginRoot(), "skills", "better-workflows", "SKILL.md"),
    path.join(pluginRoot(), "skills", "pr-to-dev", "SKILL.md")
  ];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    assert.match(content, /sent-or-indeterminate/, file);
    assert.match(content, /not-sent/, file);
    assert.match(content, /deferred/, file);
    assert.match(content, /reservation/i, file);
    assert.match(content, /provider.*repository|repository.*provider/i, file);
  }
});

test("GitHub community tabs and supporting documents are repository-local", async (context) => {
  try {
    await access(overview);
  } catch {
    context.skip("repository community files are not part of the installed plugin cache bundle");
    return;
  }
  for (const name of [
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "SECURITY.md",
    "GOVERNANCE.md",
    "SUPPORT.md"
  ]) {
    const content = await readFile(path.join(repoRoot, name), "utf8");
    assert.match(content, /\[README\]\(README\.md\)/, name);
  }
  const security = await readFile(path.join(repoRoot, "SECURITY.md"), "utf8");
  assert.match(security, /redacted `REJECTED_WITH_EVIDENCE` rationale/);
});
