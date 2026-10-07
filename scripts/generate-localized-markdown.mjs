#!/usr/bin/env node

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONNECTORS_LOCALES, DEFAULT_LOCALE, PUBLIC_LOCALE_IDS, locales } from "./website-locales.mjs";
import { EVIDENCE_CINEMA_TITLES, publicDocCards, publicDocPath, publicDocSections } from "./public-docs.mjs";
import { supportCopy } from "./localized-support.mjs";
import { policyTitle } from "./localized-policies.mjs";
import { loadPublicTexts } from "./localized-public-text.mjs";
import { referenceContentNotice } from "./reference-copy.mjs";
import { SPONSORSHIP } from "./sponsorship.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const localeDirectory = path.join(repoRoot, "docs", "locales");
const detailsDirectory = path.join(repoRoot, "docs", "details");
const languageIndexPath = path.join(repoRoot, "docs", "LANGUAGES.md");
const canonicalOrigin = "https://betterworkflows.dev";
const repositoryUrl = "https://github.com/stephen-taipei/better-workflows";
const args = process.argv.slice(2);
if (args.some((arg) => !["--check", "--preserve-deferred"].includes(arg))) {
  throw new Error("Usage: generate-localized-markdown.mjs [--check] [--preserve-deferred]");
}
const checkMode = args.includes("--check");
// Every public locale is generated. The flag only keeps unknown extra locale
// files during local experiments; public verification omits it.
const preserveDeferred = args.includes("--preserve-deferred");
const localizedPolicies = await loadPublicTexts(repoRoot);
const onboardingPolicy = localizedPolicies.find((document) => document.id === "getting-started");
const securityGuide = localizedPolicies.find((document) => document.id === "security-guide");
if (!onboardingPolicy) throw new Error("Getting started source is missing");
if (!securityGuide) throw new Error("Security guide source is missing");
if (!onboardingPolicy.texts[0]?.startsWith("# ")) throw new Error("Getting started title is missing");
const onboardingTextBlocks = onboardingPolicy.texts.length - 1;
const onboardingCommandExamples = onboardingPolicy.blocks.filter((block) => block.type === "code").length;
const onboardingFixedHeadings = onboardingPolicy.blocks.filter((block) => block.type === "fixed-heading").length;
const referenceBodyPolicies = localizedPolicies.filter((document) => document.translationMode === "canonical-english-body");
const referenceDraftInventory = referenceBodyPolicies.map((document) => {
  const codes = CONNECTORS_LOCALES.filter((code) => document.bodyTranslations?.[code]);
  return `\`${document.id}\`: ${codes.map((code) => `\`${code}\``).join(", ") || "none"}`;
}).join("; ");
const referenceDraftCatalogs = referenceBodyPolicies.flatMap((document) => Object.values(document.bodyTranslations || {}));
const referenceDraftParagraphCount = referenceDraftCatalogs.reduce((count, catalog) => count + catalog.texts.length, 0);

const localizedDetails = Object.fromEntries(locales.map(({ code }) => [code, `../details/${code}.md`]));
const generatedDetailCodes = new Set(CONNECTORS_LOCALES.filter((code) => code !== "en"));

const canonicalGuides = [
  ["getting-started", "../guide/getting-started.md"],
  ["workflows", "../guide/workflows.md"],
  ["architecture", "../guide/architecture.md"],
  ["security-guide", "../guide/security.md"],
  ["cli-reference", "../guide/cli-reference.md"]
];

function inline(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

function localeFile(code) {
  return `${code}.md`;
}

function languageLinks(currentCode) {
  return locales.map(({ code, label }) => {
    const text = inline(label);
    return code === currentCode ? `**${text}**` : `[${text}](${localeFile(code)})`;
  }).join(" · ");
}

function detailLanguageLinks(currentCode) {
  return locales.map(({ code, label }) => {
    const text = inline(label);
    return code === currentCode ? `**${text}**` : `[${text}](${localeFile(code)})`;
  }).join(" · ");
}

function detailsIndexMarkdown(locale) {
  const messages = locale.messages;
  const cards = publicDocCards(locale);
  const guideLinks = [
    [messages.QUICK_START, "getting-started"],
    [messages.CONTROL_TITLE, "workflows"],
    [messages.DOCS_TITLE, "architecture"],
    [policyTitle(securityGuide, locale.code), "security-guide"],
    ["CLI", "cli-reference"]
  ].map(([label, file]) => `- [${inline(label)}](../locales/${locale.code}/${file}.md) · \`${file}\``).join("\n");
  const publicRoutes = cards.map((page) => `- [${inline(page.title)}](${canonicalOrigin}${page.path})`).join("\n");
  return `<div align="center">

# Better Workflows

${inline(messages.DOCS_TITLE)}

${detailLanguageLinks(locale.code)}

[${inline(messages.GITHUB_CTA)}](${repositoryUrl}) · [${inline(messages.SPONSOR_CTA)}](${SPONSORSHIP.url})

</div>

## ${inline(messages.DOCS_CTA)}

${inline(messages.DESCRIPTION)}

${inline(messages.CONTROL_SUMMARY)}

${guideLinks}

## ${inline(messages.DOCS_TITLE)}

${publicRoutes}

## ${inline(EVIDENCE_CINEMA_TITLES[locale.code])}

${inline(messages.CONTROL_SUMMARY)}

## ${inline(messages.CLOSING_TITLE)}
`;
}

function markdown(locale) {
  const messages = locale.messages;
  const docsUrl = `${canonicalOrigin}${publicDocPath(locale.code, "guide")}`;
  const webPages = publicDocCards(locale).map((page) =>
    `- [${inline(page.title)}](${canonicalOrigin}${page.path})`
  ).join("\n");
  const details = localizedDetails[locale.code]
    ? `- [${inline(messages.DOCS_CTA)} · \`${locale.code}\`](${localizedDetails[locale.code]})`
    : "";
  const guideLinks = canonicalGuides.filter(([id]) => !localizedPolicies.some((doc) => doc.id === id && doc.kind === "guide")).map(([label, target]) => `- [\`${label}\`](${target}) · \`en\``).join("\n");
  const translatedPolicyLinks = localizedPolicies.map((policy) => `- [${inline(policyTitle(policy, locale.code))}](${locale.code}/${policy.id}.md) · \`${locale.code}\``).join("\n");
  const referenceSections = publicDocSections(locale, "guide").map(({ title, description }, index) =>
    `- **0${index + 1} · ${inline(title)}** — ${inline(description)}`
  ).join("\n");
  const referenceLinks = publicDocCards(locale).map((page) =>
    `- [\`${inline(page.title)}\`](${canonicalOrigin}${page.referencePath}) · \`${locale.code}\``
  ).join("\n");
  return `<div align="center">

# Better Workflows

${inline(messages.DESCRIPTION)}

${languageLinks(locale.code)}

[${inline(messages.DOCS_CTA)}](${docsUrl}) · [${inline(messages.GITHUB_CTA)}](${repositoryUrl}) · [${inline(messages.SPONSOR_CTA)}](${SPONSORSHIP.url})

</div>

${inline(locale.v5Product.scope)}

## ${inline(messages.HERO_TITLE)}<br>${inline(messages.HERO_ACCENT)}

${inline(messages.HERO_LEAD)}

## ${inline(messages.CONTROL_TITLE)}

${inline(messages.CONTROL_SUMMARY)}

- **01 · \`TaskContract\`** — ${inline(messages.HERO_LEAD)}
- **02 · \`evidence\`** — ${inline(messages.DESCRIPTION)}
- **03 · \`reconciliation\`** — ${inline(messages.CONTROL_SUMMARY)}
- **04 · \`terminal state\`** — ${inline(messages.CLOSING_TITLE)}

## ${inline(messages.QUICK_START)}

\`\`\`bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
\`\`\`

\`\`\`text
$better-workflows:auto <goal>
\`\`\`

## ${inline(messages.DOCS_TITLE)}

${webPages}

### ${inline(messages.DOCS_CTA)} · \`${locale.code}\`

${inline(referenceContentNotice(locale.code))}

${referenceSections}

${referenceLinks}

${details}
- [\`README · en\`](../../README.md)
- [\`LOCALIZATION\`](../LOCALIZATION.md)

### ${inline(messages.DOCS_CTA)} · \`en\`

${guideLinks}

### ${inline(messages.DOCS_CTA)} · \`${locale.code}\`

${translatedPolicyLinks}
- [${inline(supportCopy[locale.code].title)}](${locale.code}/support.md) · \`${locale.code}\`

## ${inline(messages.SPONSOR_TITLE)}

${inline(messages.SPONSOR_BODY)}

[${inline(messages.SPONSOR_CTA)}](${SPONSORSHIP.url})

---

${inline(messages.CLOSING_TITLE)}
`;
}

function languageIndex() {
  const rows = locales.map(({ code, label }) => {
    const homepage = code === DEFAULT_LOCALE ? `${canonicalOrigin}/` : `${canonicalOrigin}/${code}/`;
    const docs = `${canonicalOrigin}${publicDocPath(code, "guide")}`;
    return `| \`${code}\` | ${inline(label)} | [Overview](locales/${localeFile(code)}) · [Details](details/${code}.md) · [Website](${homepage}) · [Docs entry](${docs}) |`;
  }).join("\n");
  return `# Better Workflows language index

Better Workflows publishes ${locales.length} locale editions. Each locale has a website, a localized overview, localized documentation routes and the support policy. Technical identifiers and commands remain exact English identifiers inside translated prose. See the [localization terminology policy](LOCALIZATION.md).

| Locale | Native label | Links |
| --- | --- | --- |
${rows}

Default locale: \`${DEFAULT_LOCALE}\`. English remains canonical for runtime contracts. Editions other than \`en\` and \`zh-Hant-TW\` are machine-assisted translations that still need native-speaker review.
`;
}

async function assertExact(filePath, expected) {
  let actual;
  try {
    actual = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Missing generated documentation: ${path.relative(repoRoot, filePath)}`, { cause: error });
  }
  if (actual !== expected) throw new Error(`Generated documentation drift: ${path.relative(repoRoot, filePath)}`);
}

if (checkMode) {
  const files = (await readdir(localeDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  const expectedFiles = CONNECTORS_LOCALES.map(localeFile).sort();
  if (!preserveDeferred && JSON.stringify(files) !== JSON.stringify(expectedFiles)) throw new Error("Generated locale file set drift");
  if (preserveDeferred && expectedFiles.some((file) => !files.includes(file))) throw new Error("Missing RC1 generated locale file");
  for (const locale of locales) await assertExact(path.join(localeDirectory, localeFile(locale.code)), markdown(locale));
  await assertExact(languageIndexPath, languageIndex());
  for (const code of generatedDetailCodes) {
    const locale = locales.find((item) => item.code === code);
    await assertExact(path.join(detailsDirectory, `${code}.md`), detailsIndexMarkdown(locale));
  }
} else {
  await mkdir(localeDirectory, { recursive: true });
  await mkdir(detailsDirectory, { recursive: true });
  for (const entry of preserveDeferred ? [] : await readdir(localeDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md") && !CONNECTORS_LOCALES.includes(entry.name.slice(0, -3))) {
      await unlink(path.join(localeDirectory, entry.name));
    }
  }
  for (const locale of locales) await writeFile(path.join(localeDirectory, localeFile(locale.code)), markdown(locale));
  await writeFile(languageIndexPath, languageIndex());
  for (const code of generatedDetailCodes) {
    const locale = locales.find((item) => item.code === code);
    await writeFile(path.join(detailsDirectory, `${code}.md`), detailsIndexMarkdown(locale));
  }
}

console.log(JSON.stringify({ mode: checkMode ? "check" : "write", locales: locales.length, localeDirectory, languageIndexPath }, null, 2));
