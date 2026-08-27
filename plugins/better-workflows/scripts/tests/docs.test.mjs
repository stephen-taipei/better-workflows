import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pluginRoot, VERSION } from "../lib/core.mjs";
import { loadHostSupportRegistry, renderHostSupportMarkdown } from "../lib/hosts.mjs";

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
  path.join(repoRoot, "docs", "guide", "cli-reference.md"),
  path.join(repoRoot, "docs", "guide", "readme-quality.md")
];
const readmeQualityContractPath = path.join(pluginRoot(), "config", "readme-quality-v1.json");
const deliberationRosterPath = path.join(pluginRoot(), "config", "deliberation-roster.json");
const deliberationSkillPath = path.join(pluginRoot(), "skills", "better-workflows", "SKILL.md");
const deliberationReferencePath = path.join(
  pluginRoot(),
  "skills",
  "better-workflows",
  "references",
  "deliberation-roster.md"
);
const MODEL_BRANDS = Object.freeze([
  "Codex", "Claude", "Gemini", "GPT-OSS", "Grok", "Cursor", "Kimi", "Qwen", "Kiro"
]);
const AGY_TRANSPORT_COMMAND = "agy";
const AGY_MODEL_BRANDS = Object.freeze(["Gemini", "Claude", "GPT-OSS"]);

test("canonical roster terminology stays synchronized across config, skill, reference, tests, and public docs", async (context) => {
  try {
    await access(overview);
  } catch {
    context.skip("repository README files are not part of the installed plugin cache bundle");
    return;
  }
  const roster = JSON.parse(await readFile(deliberationRosterPath, "utf8"));
  const quality = await loadReadmeQualityContract();
  const sortBrands = (brands) => [...new Set(brands)].sort((left, right) => left.localeCompare(right, "en"));
  assert.equal(roster.schemaVersion, 3);
  assert.deepEqual(roster.terminology.modelBrands, MODEL_BRANDS);
  assert.equal(roster.terminology.transportCommand, AGY_TRANSPORT_COMMAND);
  assert.deepEqual(roster.terminology.transportModelBrands, AGY_MODEL_BRANDS);
  assert.equal(roster.terminology.transportIsModelBrand, false);
  assert.deepEqual(
    sortBrands(roster.providers.flatMap((provider) => provider.models.map((model) => model.brand))),
    sortBrands(MODEL_BRANDS)
  );
  assert.deepEqual(
    sortBrands(
      roster.providers
        .filter((provider) => provider.command === AGY_TRANSPORT_COMMAND)
        .flatMap((provider) => provider.models.map((model) => model.brand))
    ),
    sortBrands(AGY_MODEL_BRANDS)
  );

  const publicReadmes = await Promise.all(
    quality.landing.files.map(async (fileContract) => ({
      label: fileContract.path,
      content: await readFile(path.join(repoRoot, fileContract.path), "utf8")
    }))
  );
  const synchronizedSurfaces = [
    { label: "better-workflows skill", content: await readFile(deliberationSkillPath, "utf8") },
    { label: "deliberation roster reference", content: await readFile(deliberationReferencePath, "utf8") },
    { label: "README quality contract", content: JSON.stringify(quality) },
    ...publicReadmes
  ];
  for (const surface of synchronizedSurfaces) {
    for (const brand of MODEL_BRANDS) assert.match(surface.content, new RegExp(brand), `${surface.label}: ${brand}`);
    assert.match(surface.content, new RegExp(`\\b${AGY_TRANSPORT_COMMAND}\\b`), `${surface.label}: transport`);
    for (const brand of AGY_MODEL_BRANDS) {
      assert.match(surface.content, new RegExp(brand), `${surface.label}: transported ${brand}`);
    }
  }
  for (const file of [deliberationSkillPath, deliberationReferencePath, overview]) {
    assert.match(await readFile(file, "utf8"), /(?:not|never) (?:itself )?(?:another |a )?model brand/, file);
  }
});

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
  assert.match(content, /result receipt/, file);
  assert.match(content, /prompt digest/, file);
  assert.match(content, /response digest/, file);
  assert.match(content, /Evaluation v2\.4/, file);
  assert.match(content, /immutable v2\.2/, file);
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

async function loadReadmeQualityContract() {
  return JSON.parse(await readFile(readmeQualityContractPath, "utf8"));
}

function masked(value) {
  return value.replace(/[^\n]/g, " ");
}

function landingMarkdownStructure(content) {
  const comments = [];
  const withoutComments = content.replace(/<!--([\s\S]*?)-->/g, (match, body, offset) => {
    comments.push({ body: body.trim(), start: offset, end: offset + match.length });
    return masked(match);
  });
  const chunks = withoutComments.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const visible = [];
  const fences = [];
  let offset = 0;
  let openFence = null;
  for (const chunk of chunks) {
    const line = chunk.replace(/\n$/, "");
    if (!openFence) {
      const opening = line.match(/^\s{0,3}(`{3,}|~{3,})([A-Za-z0-9_-]*)\s*$/);
      if (opening) {
        openFence = {
          marker: opening[1][0],
          markerLength: opening[1].length,
          language: opening[2],
          start: offset,
          bodyStart: offset + chunk.length
        };
        visible.push(masked(chunk));
      } else {
        visible.push(chunk);
      }
    } else if (new RegExp(`^\\s{0,3}${openFence.marker}{${openFence.markerLength},}\\s*$`).test(line)) {
      fences.push({
        ...openFence,
        body: withoutComments.slice(openFence.bodyStart, offset),
        end: offset + chunk.length,
        closed: true
      });
      openFence = null;
      visible.push(masked(chunk));
    } else {
      visible.push(masked(chunk));
    }
    offset += chunk.length;
  }
  if (openFence) {
    fences.push({
      ...openFence,
      body: withoutComments.slice(openFence.bodyStart),
      end: content.length,
      closed: false
    });
  }
  const outsideFence = (position) => !fences.some((fence) => position >= fence.start && position < fence.end);
  const controls = comments.flatMap((comment) => {
    if (!outsideFence(comment.start)) return [];
    if (comment.body === "readme-roster") return [{ ...comment, kind: "readme-roster", key: null }];
    const match = comment.body.match(/^(readme-(?:section|claim|visual-fallback)):([a-z0-9-]+)$/);
    return match ? [{ ...comment, kind: match[1], key: match[2] }] : [];
  }).sort((left, right) => left.start - right.start);
  return {
    content,
    visible: visible.join(""),
    fences,
    controls,
    unclosedFence: fences.some((fence) => !fence.closed)
  };
}

function controlValues(structure, kind) {
  return structure.controls.filter((entry) => entry.kind === kind).map((entry) => entry.key);
}

function controlSegment(structure, kind, key, terminatingKinds) {
  const marker = structure.controls.find((entry) => entry.kind === kind && entry.key === key);
  if (!marker) return { marker: null, start: -1, end: -1, visible: "", fences: [] };
  const next = structure.controls.find((entry) => entry.start > marker.start && terminatingKinds.includes(entry.kind));
  const end = next?.start ?? structure.content.length;
  return {
    marker,
    start: marker.end,
    end,
    visible: structure.visible.slice(marker.end, end),
    fences: structure.fences.filter((fence) => fence.start >= marker.end && fence.end <= end)
  };
}

function headingEntries(content) {
  return [...content.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)].map((match) => ({
    level: match[1].length,
    text: match[2]
  }));
}

function markerValues(content, prefix) {
  const pattern = new RegExp(`<!--\\s*${prefix}:([a-z0-9-]+)\\s*-->`, "g");
  return [...content.matchAll(pattern)].map((match) => match[1]);
}

function markdownTargets(content) {
  const targets = [];
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
    targets.push(match[1]);
  }
  for (const match of content.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) {
    targets.push(match[1]);
  }
  return targets;
}

function isRelativeTarget(target) {
  return !target.startsWith("#")
    && !target.startsWith("//")
    && !/^[a-z][a-z0-9+.-]*:/i.test(target);
}

function normalizeTarget(target) {
  return target.replace(/^<|>$/g, "").split("#", 1)[0].split("?", 1)[0];
}

function resolvedRepoTargets(file, content) {
  return markdownTargets(content)
    .filter(isRelativeTarget)
    .map(normalizeTarget)
    .filter(Boolean)
    .map((target) => path.relative(repoRoot, path.resolve(path.dirname(file), target)).split(path.sep).join("/"));
}

function tableBlocks(content) {
  const lines = content.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length;) {
    if (!/^\s*\|.*\|\s*$/.test(lines[index])) {
      index += 1;
      continue;
    }
    const block = [];
    while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
      block.push(lines[index]);
      index += 1;
    }
    if (block.length >= 2 && /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(block[1])) {
      blocks.push(block);
    }
  }
  return blocks;
}

function tableColumnCount(line) {
  return line.trim().slice(1, -1).replaceAll("\\|", "__ESCAPED_PIPE__").split("|").length;
}

function proseParagraphs(content) {
  const paragraphs = [];
  let current = [];
  let inFence = false;
  const flush = () => {
    if (current.length > 0) {
      paragraphs.push(current.join(" ").replace(/\s+/g, " ").trim());
      current = [];
    }
  };
  for (const line of content.split("\n")) {
    if (/^```/.test(line.trim())) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (
      line.trim() === ""
      || /^#{1,6}\s/.test(line)
      || /^\s*\|.*\|\s*$/.test(line)
      || /^\s*<!--.*-->\s*$/.test(line)
      || /^\s*<\/?(?:div|details|summary)[^>]*>\s*$/.test(line)
      || /^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line)
    ) {
      flush();
      continue;
    }
    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      flush();
      paragraphs.push(line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim());
      continue;
    }
    current.push(line.trim());
  }
  flush();
  return paragraphs.filter(Boolean);
}

function readableFallback(structure, key) {
  return controlSegment(structure, "readme-visual-fallback", key, ["readme-section"])
    .visible
    .replace(/\[[^\]]+\]\([^)]+\)/g, "$1")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function validateFences(structure, errors) {
  for (const fence of structure.fences) {
    if (!fence.language) errors.push(`code fence language at line ${structure.content.slice(0, fence.start).split("\n").length}`);
  }
  if (structure.unclosedFence) errors.push("unclosed code fence");
}

function validateLandingReadme(content, file, fileContract, contract) {
  const errors = [];
  const structure = landingMarkdownStructure(content);
  const visible = structure.visible;
  const headings = headingEntries(visible);
  const h1 = headings.filter((entry) => entry.level === 1);
  if (h1.length !== 1) errors.push(`H1 count ${h1.length}`);
  for (let index = 1; index < headings.length; index += 1) {
    if (headings[index].level > headings[index - 1].level + 1) {
      errors.push(`heading hierarchy skips from H${headings[index - 1].level} to H${headings[index].level}`);
    }
  }
  const h2 = headings.filter((entry) => entry.level === 2).map((entry) => entry.text);
  if (JSON.stringify(h2) !== JSON.stringify(fileContract.headings)) errors.push("H2 narrative order");
  const sectionMarkers = controlValues(structure, "readme-section");
  if (JSON.stringify(sectionMarkers) !== JSON.stringify(contract.sectionOrder)) errors.push("section marker order");
  const rosterMarkers = structure.controls.filter((entry) => entry.kind === "readme-roster");
  const rosterMarkerCount = rosterMarkers.length;
  const firstSection = structure.controls.find((entry) => entry.kind === "readme-section" && entry.key === "promise-audience")?.start ?? -1;
  const rosterPosition = rosterMarkers[0]?.start ?? -1;
  if (rosterMarkerCount !== 1 || rosterPosition === -1 || rosterPosition > firstSection) errors.push("preamble roster placement");
  if (!visible.slice(0, firstSection).includes(fileContract.preambleRoster)) errors.push("preamble roster wording");
  const claimMarkers = controlValues(structure, "readme-claim");
  if (JSON.stringify(claimMarkers) !== JSON.stringify(contract.claimOrder)) errors.push("claim marker order");
  for (const key of contract.claimOrder) {
    const segment = controlSegment(structure, "readme-claim", key, ["readme-claim", "readme-section"]);
    if (!segment.visible.includes(fileContract.claims[key])) errors.push(`claim ${key} wording`);
  }
  for (const identifier of contract.requiredIdentifiers) {
    if (!visible.includes(identifier)) errors.push(`required identifier ${identifier}`);
  }
  const firstSuccess = controlSegment(structure, "readme-section", "first-success", ["readme-section"]);
  if (!firstSuccess.marker) {
    errors.push("first-success placement");
  } else {
    const commandBlocks = firstSuccess.fences
      .filter((fence) => fence.language !== "mermaid")
      .map((fence) => fence.body)
      .join("\n");
    for (const command of contract.requiredCommands) {
      if (!commandBlocks.includes(command)) errors.push(`first-success command ${command}`);
    }
  }
  const lines = content.trimEnd().split("\n");
  if (lines.length > contract.maxLines) errors.push(`line budget ${lines.length}`);
  for (const [index, paragraph] of proseParagraphs(visible).entries()) {
    if ([...paragraph].length > contract.maxParagraphCharacters) {
      errors.push(`paragraph budget ${index + 1}`);
    }
  }
  for (const [index, table] of tableBlocks(visible).entries()) {
    if (tableColumnCount(table[0]) > contract.maxTableColumns) errors.push(`table columns ${index + 1}`);
    if (table.length - 2 > contract.maxTableBodyRows) errors.push(`table rows ${index + 1}`);
    if (table.some((line) => tableColumnCount(line) !== tableColumnCount(table[0]))) {
      errors.push(`table shape ${index + 1}`);
    }
  }
  for (const pattern of contract.bannedDeepDetailPatterns) {
    if (visible.toLocaleLowerCase("en-US").includes(pattern.toLocaleLowerCase("en-US"))) {
      errors.push(`deep detail ${pattern}`);
    }
  }
  const images = [...visible.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
    .map((match) => ({ alt: match[1].trim(), target: match[2] }));
  if (images.some((image) => image.alt === "")) errors.push("image alt text");
  const relativeImages = images.filter((image) => isRelativeTarget(image.target));
  const expectedVisual = contract.visuals.find((visual) => visual.type === "image").target;
  const visualTargets = relativeImages.map((image) => path.relative(
    repoRoot,
    path.resolve(path.dirname(file), normalizeTarget(image.target))
  ).split(path.sep).join("/"));
  if (visualTargets.length !== 1 || visualTargets[0] !== expectedVisual) errors.push("authority visual target");
  const mermaidCount = structure.fences.filter((fence) => fence.language === "mermaid").length;
  if (mermaidCount !== 1) errors.push(`Mermaid count ${mermaidCount}`);
  for (const visual of contract.visuals) {
    const fallback = readableFallback(structure, visual.key);
    if ([...fallback].length < 80) errors.push(`visual fallback ${visual.key}`);
  }
  validateFences(structure, errors);
  const resolved = new Set(resolvedRepoTargets(file, visible));
  for (const target of [...contract.requiredRepoTargets, fileContract.detailsTarget]) {
    if (!resolved.has(target)) errors.push(`required target ${target}`);
  }
  return errors;
}

function validateRecipeReadme(content, fileContract, contract) {
  const errors = [];
  const headings = headingEntries(content);
  if (headings.filter((entry) => entry.level === 1).length !== 1) errors.push("recipe H1 count");
  const h2 = headings.filter((entry) => entry.level === 2).map((entry) => entry.text);
  if (JSON.stringify(h2) !== JSON.stringify(fileContract.headings)) errors.push("recipe H2 order");
  const markers = markerValues(content, "recipe-readme-section");
  if (JSON.stringify(markers) !== JSON.stringify(contract.sectionOrder)) errors.push("recipe section order");
  if (content.trimEnd().split("\n").length > contract.maxLines) errors.push("recipe line budget");
  for (const token of fileContract.requiredTokens) {
    if (!content.includes(token)) errors.push(`recipe token ${token}`);
  }
  validateFences(landingMarkdownStructure(content), errors);
  return errors;
}

async function assertRelativeTargetsExist(file, content) {
  const visible = landingMarkdownStructure(content).visible;
  for (const target of markdownTargets(visible).filter(isRelativeTarget).map(normalizeTarget).filter(Boolean)) {
    await access(path.resolve(path.dirname(file), target));
  }
}

test("all landing READMEs satisfy the narrative, trust, visual, and scan-quality contract", async (context) => {
  try {
    await access(overview);
  } catch {
    context.skip("repository README files are not part of the installed plugin cache bundle");
    return;
  }
  const quality = await loadReadmeQualityContract();
  for (const fileContract of quality.landing.files) {
    const file = path.join(repoRoot, fileContract.path);
    const content = await readFile(file, "utf8");
    assert.deepEqual(
      validateLandingReadme(content, file, fileContract, quality.landing),
      [],
      file
    );
    await assertRelativeTargetsExist(file, content);
    for (const brand of MODEL_BRANDS) {
      assert.match(content, new RegExp(brand), `${file}: ${brand}`);
    }
  }
  assert.match(
    await readFile(overview, "utf8"),
    /`agy` transports Gemini-, Claude-, and GPT-OSS-branded models; it is transport metadata, not another model brand/,
  );
});

test("README quality rejects hidden comments, fenced examples, wrong-section claims, commands, links, and headings", async (context) => {
  try {
    await access(overview);
  } catch {
    context.skip("repository README files are not part of the installed plugin cache bundle");
    return;
  }
  const quality = await loadReadmeQualityContract();
  const fileContract = quality.landing.files.find((entry) => entry.path === "README.md");
  const content = await readFile(overview, "utf8");
  const promptClaim = fileContract.claims["prompt-not-authority"];
  const gettingStarted = "docs/guide/getting-started.md";
  const marketplaceCommand = "codex plugin marketplace add stephen-taipei/better-workflows";
  const cases = [
    {
      label: "claim prompt-not-authority wording",
      content: content.replace(fileContract.claims["prompt-not-authority"], "Intent appears here without the governed claim.")
    },
    {
      label: "preamble roster wording",
      content: content.replace(fileContract.preambleRoster, "A model list without its transport boundary.")
    },
    {
      label: "H1 count",
      content: `${content}\n# Competing entry point\n`
    },
    {
      label: "visual fallback lifecycle",
      content: content.replace("<!-- readme-visual-fallback:lifecycle -->", "")
    },
    {
      label: "table columns",
      content: content.replace(
        "| Without governance | With Better Workflows |",
        "| A | B | C | D | E |\n| --- | --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 |\n\n| Without governance | With Better Workflows |"
      )
    },
    {
      label: "required target docs/guide/getting-started.md",
      content: content.replaceAll("docs/guide/getting-started.md", "docs/guide/missing.md")
    },
    {
      label: "code fence language",
      content: content.replace("```bash", "```")
    },
    {
      label: "paragraph budget",
      content: content.replace(
        "<!-- readme-section:problem-outcome -->",
        `${"One deliberately unscannable sentence ".repeat(25)}\n\n<!-- readme-section:problem-outcome -->`
      )
    },
    {
      label: "claim prompt-not-authority wording",
      content: content.replace(promptClaim, `<!-- ${promptClaim} -->`)
    },
    {
      label: "claim prompt-not-authority wording",
      content: content.replace(promptClaim, `\`\`\`text\n${promptClaim}\n\`\`\``)
    },
    {
      label: "claim prompt-not-authority wording",
      content: content.replace(promptClaim, `~~~text\n${promptClaim}\n~~~`)
    },
    {
      label: "claim prompt-not-authority wording",
      content: content
        .replace(promptClaim, "Intent is described without the governed claim.")
        .replace("<!-- readme-claim:root-only-mutation -->", `<!-- readme-claim:root-only-mutation -->\n${promptClaim}`)
    },
    {
      label: `required target ${gettingStarted}`,
      content: content
        .replaceAll(gettingStarted, "docs/guide/not-getting-started.md")
        .replace("<!-- readme-section:promise-audience -->", `<!-- [Hidden target](${gettingStarted}) -->\n<!-- readme-section:promise-audience -->`)
    },
    {
      label: `required target ${gettingStarted}`,
      content: `${content.replaceAll(gettingStarted, "docs/guide/not-getting-started.md")}\n\`\`\`text\n[Hidden target](${gettingStarted})\n\`\`\`\n`
    },
    {
      label: `first-success command ${marketplaceCommand}`,
      content: content
        .replace(marketplaceCommand, "# marketplace command intentionally removed")
        .replace("<!-- readme-section:first-success -->", `<!-- readme-section:first-success -->\n<!-- ${marketplaceCommand} -->`)
    },
    {
      label: `first-success command ${marketplaceCommand}`,
      content: `${content.replace(marketplaceCommand, "# marketplace command intentionally removed")}\n\`\`\`bash\n${marketplaceCommand}\n\`\`\`\n`
    },
    {
      label: "required identifier Goal-first",
      content: `${content.replace("Goal-first", "Outcome-first")}\n\`\`\`text\nGoal-first\n\`\`\`\n`
    },
    {
      label: "H2 narrative order",
      content: `${content.replace("## Better Workflows in plain language", "## A different visible heading")}\n\`\`\`text\n## Better Workflows in plain language\n\`\`\`\n`
    }
  ];
  for (const item of cases) {
    const errors = validateLandingReadme(item.content, overview, fileContract, quality.landing);
    assert.ok(errors.some((error) => error.includes(item.label)), `${item.label}: ${errors.join(", ")}`);
  }
});

test("reference recipe README exposes a bounded input-to-promotion contract", async () => {
  const quality = await loadReadmeQualityContract();
  for (const fileContract of quality.recipe.files) {
    const file = path.join(repoRoot, fileContract.path);
    const content = await readFile(file, "utf8");
    assert.deepEqual(validateRecipeReadme(content, fileContract, quality.recipe), [], file);
    await assertRelativeTargetsExist(file, content);
    assert.match(content, /no network or shell/);
    assert.match(content, /cannot mutate source/);
    assert.match(content, /cannot accept its own evidence/);
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

test("public host support matrix and extension versions stay bound to host-support-v1", async (context) => {
  try {
    await access(overview);
  } catch {
    context.skip("repository public files are not part of the installed plugin cache bundle");
    return;
  }
  const registry = await loadHostSupportRegistry();
  const readme = await readFile(overview, "utf8");
  const block = readme.match(/<!-- host-support-v1:start -->\n([\s\S]*?)\n<!-- host-support-v1:end -->/);
  assert.ok(block, "README host-support-v1 block");
  assert.equal(block[1], renderHostSupportMarkdown(registry));
  assert.match(readme, /Official recommendation: macOS \+ Codex/);
  assert.match(readme, /host-native UX may differ/);

  for (const relativePath of [
    ".claude-plugin/marketplace.json",
    "gemini-extension.json",
    "qwen-extension.json",
    "plugins/better-workflows/.claude-plugin/plugin.json",
    "plugins/better-workflows/gemini-extension.json",
    "plugins/better-workflows/qwen-extension.json"
  ]) {
    const manifest = JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
    const declared = relativePath.endsWith("marketplace.json") ? manifest.plugins[0].version : manifest.version;
    assert.equal(declared, VERSION, relativePath);
  }
});

test("Auto and Direct skills enforce repository preflight, risk admission, isolation, and honest completion", async () => {
  const files = [
    path.join(pluginRoot(), "skills", "auto", "SKILL.md"),
    path.join(pluginRoot(), "skills", "direct", "SKILL.md"),
    path.join(pluginRoot(), "skills", "better-workflows", "SKILL.md")
  ];
  const content = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  assert.match(content, /workspace preflight --intent read-only/);
  assert.match(content, /workspace preflight[^\n]*--intent modify|--intent modify/);
  assert.match(content, /AutoRiskAssessmentV1/);
  assert.match(content, /irreversibility[^\n]*zero|irreversibility `0`/);
  assert.match(content, /total[^\n]*two|total[^\n]*`2`/);
  assert.match(content, /TaskWorkspaceLeaseV1/);
  assert.match(content, /workspace register/);
  assert.match(content, /host[^\n]*preserv|preserve[^\n]*host/i);
  assert.match(content, /workspace reconcile/);
  assert.match(content, /squash[^\n]*receipt|receipt[^\n]*squash/i);
  assert.match(content, /Never auto-stash|Never stash/);
  assert.match(content, /120-second/);
  assert.match(content, /pr-required[^\n]*not completion/);
  assert.match(content, /補做證據驗證/);
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
