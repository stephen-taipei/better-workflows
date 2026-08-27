#!/usr/bin/env node

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONNECTORS_LOCALES, DEFAULT_LOCALE, locales } from "./website-locales.mjs";
import { publicDocCards, publicDocPath } from "./public-docs.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const localeDirectory = path.join(repoRoot, "docs", "locales");
const languageIndexPath = path.join(repoRoot, "docs", "LANGUAGES.md");
const canonicalOrigin = "https://betterworkflows.dev";
const repositoryUrl = "https://github.com/stephen-taipei/better-workflows";
const checkMode = process.argv.includes("--check");

const localizedDetails = {
  en: "../details/en.md",
  ja: "../details/ja.md",
  ko: "../details/ko.md",
  "zh-Hans": "../details/zh-CN.md",
  "zh-Hant-TW": "../details/zh-TW.md"
};

const canonicalGuides = [
  ["getting-started", "../guide/getting-started.md"],
  ["workflows", "../guide/workflows.md"],
  ["architecture", "../guide/architecture.md"],
  ["security", "../guide/security.md"],
  ["cli-reference", "../guide/cli-reference.md"],
  ["readme-quality", "../guide/readme-quality.md"]
];

const canonicalPolicies = [
  ["CODE_OF_CONDUCT", "../../CODE_OF_CONDUCT.md"],
  ["CONTRIBUTING", "../../CONTRIBUTING.md"],
  ["GOVERNANCE", "../../GOVERNANCE.md"],
  ["SECURITY", "../../SECURITY.md"],
  ["SUPPORT", "../../SUPPORT.md"],
  ["THIRD_PARTY_NOTICES", "../../THIRD_PARTY_NOTICES.md"],
  ["ANSIBLE", "../../deploy/ansible/README.md"]
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

function markdown(locale) {
  const messages = locale.messages;
  const docsUrl = `${canonicalOrigin}${publicDocPath(locale.code, "guide")}`;
  const webPages = publicDocCards(locale).map((page) =>
    `- [${inline(page.title)}](${canonicalOrigin}${page.path})`
  ).join("\n");
  const details = localizedDetails[locale.code]
    ? `- [\`DETAILS · ${locale.code}\`](${localizedDetails[locale.code]})`
    : "";
  const guideLinks = canonicalGuides.map(([label, target]) => `- [\`${label}\`](${target}) · \`en\``).join("\n");
  const policyLinks = canonicalPolicies.map(([label, target]) => `- [\`${label}\`](${target}) · \`en\``).join("\n");
  return `<div align="center">

# Better Workflows

${inline(messages.DESCRIPTION)}

${languageLinks(locale.code)}

[${inline(messages.DOCS_CTA)}](${docsUrl}) · [${inline(messages.GITHUB_CTA)}](${repositoryUrl}) · [${inline(messages.SPONSOR_CTA)}](https://ko-fi.com/betterworkflows)

</div>

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

${details}
- [\`README · en\`](../../README.md)
- [\`LOCALIZATION\`](../LOCALIZATION.md)

### \`GUIDES · en\`

${guideLinks}

### \`POLICIES · en\`

${policyLinks}

### \`RUNTIME SOURCE · en\`

- [\`plugins/better-workflows/skills/\`](../../plugins/better-workflows/skills/)
- [\`evidence-cinema/imagegen-manifest\`](../html/evidence-cinema/assets/imagegen-manifest.md)
- [\`use-cases/color-system\`](../html/use-cases/assets/color-system.md)
- [\`use-cases/imagegen-manifest\`](../html/use-cases/assets/imagegen-manifest.md)
- [${inline(messages.GITHUB_CTA)}](${repositoryUrl})

## ${inline(messages.SPONSOR_TITLE)}

${inline(messages.SPONSOR_BODY)}

[${inline(messages.SPONSOR_CTA)}](https://ko-fi.com/betterworkflows)

---

${inline(messages.CLOSING_TITLE)}
`;
}

function languageIndex() {
  const rows = locales.map(({ code, label }) => {
    const homepage = code === DEFAULT_LOCALE ? `${canonicalOrigin}/` : `${canonicalOrigin}/${code}/`;
    const docs = `${canonicalOrigin}${publicDocPath(code, "guide")}`;
    return `| \`${code}\` | ${inline(label)} | [Overview](locales/${localeFile(code)}) | [Website](${homepage}) | [Docs entry](${docs}) |`;
  }).join("\n");
  return `# Better Workflows — 41 locales

The locale inventory follows the Connectors iOS BCP 47 set. Technical identifiers, CLI commands, template IDs, evidence kinds, and normative security contracts remain exact English identifiers inside every localized edition. See the [localization terminology policy](LOCALIZATION.md) for the distinction between localized prose and exact runtime identifiers.

| Locale | Native label | Localized overview | Official site | Official docs entry |
| --- | --- | --- | --- | --- |
${rows}

Default locale: \`${DEFAULT_LOCALE}\`. Each locale has a translated overview and five official web entry routes. The embedded interactive references and normative implementation, operational, legal, and security documents retain their declared source language; English remains canonical for normative contracts.
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
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) throw new Error("Generated locale file set drift");
  for (const locale of locales) await assertExact(path.join(localeDirectory, localeFile(locale.code)), markdown(locale));
  await assertExact(languageIndexPath, languageIndex());
} else {
  await mkdir(localeDirectory, { recursive: true });
  for (const entry of await readdir(localeDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md") && !CONNECTORS_LOCALES.includes(entry.name.slice(0, -3))) {
      await unlink(path.join(localeDirectory, entry.name));
    }
  }
  for (const locale of locales) await writeFile(path.join(localeDirectory, localeFile(locale.code)), markdown(locale));
  await writeFile(languageIndexPath, languageIndex());
}

console.log(JSON.stringify({ mode: checkMode ? "check" : "write", locales: locales.length, localeDirectory, languageIndexPath }, null, 2));
