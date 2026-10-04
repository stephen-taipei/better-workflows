import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const POLICY_SPECS = Object.freeze([
  { id: "security", source: "SECURITY.md", sha256: "a16157ba5c7878255a8c6b83a10edfb8d157f03df3a2b1a542a5e2f34ee0b808" },
  { id: "contributing", source: "CONTRIBUTING.md", sha256: "2dcb0c18d578937b481e6588ae76784829d1a33855ea6bede5d003dfe33a935d" },
  { id: "governance", source: "GOVERNANCE.md", sha256: "1639c4634b05d69d4512a56cd48a9554ef5530423cc72b7d1f20387b22c9ce04" }
]);

export function markdownBlocks(source) {
  const blocks = [];
  let lines = [];
  let fence = null;
  for (const line of source.replaceAll("\r\n", "\n").trimEnd().split("\n")) {
    const marker = line.match(/^(`{3,}|~{3,})/);
    if (marker && !fence) fence = marker[1];
    else if (marker && fence && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    if (!fence && !line.trim()) {
      if (lines.length) blocks.push(lines.join("\n"));
      lines = [];
    } else lines.push(line);
  }
  if (fence) throw new Error("Unclosed source code fence");
  if (lines.length) blocks.push(lines.join("\n"));
  return blocks;
}

export function describePolicySource(spec, source) {
  if (createHash("sha256").update(source).digest("hex") !== spec.sha256) {
    throw new Error(`Policy source changed; review all locale editions before updating source pins: ${spec.source}`);
  }
  const links = [];
  let textIndex = 0;
  const blocks = markdownBlocks(source).map((block) => {
    if (/^```/.test(block)) return { type: "code", source: block };
    if (spec.fixedTableHeader && block.startsWith(spec.fixedTableHeader)) return { type: "fixed-table", source: block };
    if (spec.fixedHeadings?.includes(block)) {
      if (!["### Claude Code", "### Gemini CLI", "### Qwen Code"].includes(block)) throw new Error("Invalid fixed proper-name heading");
      return { type: "fixed-heading", source: block };
    }
    if (block.startsWith("| [README](README.md)") || (spec.navigationPrefix && block.startsWith(spec.navigationPrefix))) {
      return { type: "navigation", source: block };
    }
    // Keep link targets out of translators' prose; each exact placeholder is required.
    const text = block.replace(/\]\(([^)]+)\)/g, (_, target) => {
      const index = links.push(target) - 1;
      return `]({LINK_${index}})`;
    });
    // Proper project names and source-owned URLs are identifiers, not untranslated prose.
    // Only the exact pinned notices document opts into this fixed reference-list form.
    if (spec.fixedReferenceList && block.split("\n").every((line) => /^- \[[^\]]+\]\(https:\/\/[^)]+\)$/.test(line))) {
      return { type: "reference-links", source: block, text };
    }
    return { type: "text", index: textIndex++, source: block, text };
  });
  return { ...spec, links, blocks, texts: blocks.filter((block) => block.type === "text").map((block) => block.text) };
}

export async function loadPolicySources(repositoryRoot) {
  return Promise.all(POLICY_SPECS.map(async (spec) => describePolicySource(spec, await readFile(path.join(repositoryRoot, spec.source), "utf8"))));
}

export function structuralSignature(block) {
  return {
    headings: [...block.matchAll(/^(#{1,6})\s+/gm)].map((item) => item[1]),
    lists: [...block.matchAll(/^(\s*(?:-|\d+\.)\s+(?:\[[ x]\]\s+)?)/gm)].map((item) => item[1]),
    tableColumns: block.split("\n").filter((line) => line.startsWith("|")).map((line) => line.split("|").length),
    tableDelimiters: block.split("\n").filter((line) => /^\|(?:\s*:?-+:?\s*\|)+$/.test(line)),
    links: [...block.matchAll(/\{LINK_\d+\}/g)].map((item) => item[0]).sort(),
    code: [...block.matchAll(/`([^`]+)`/g)].map((item) => item[1]).sort(),
    emphasisCount: [...block.matchAll(/\*\*[^*]+\*\*/g)].length,
    checks: [...block.matchAll(/\[[ x]\]/g)].map((item) => item[0]),
    numbers: [...block.matchAll(/\d+/g)].map((item) => item[0]).sort(),
    // Do not translate runtime symbols or turn fail-closed into an open fallback.
    identifiers: [...block.matchAll(/\b(?:Better Workflows|Graph View|Codex|Node\.js|Node|GitHub|Root|REJECTED_WITH_EVIDENCE|SLA|CLI|READMEs?|Mermaid|Diátaxis|SECURITY\.md)\b/g)].map((item) => item[0] === "READMEs" ? "README" : item[0]).sort()
  };
}

export function validatePolicyText(source, translated, context) {
  if (typeof translated !== "string" || !translated.trim()) throw new Error(`Missing policy paragraph: ${context}`);
  if (/[\u202a-\u202e\u2066-\u2069]/u.test(translated)) throw new Error(`Unapproved bidi control in translation: ${context}`);
  if (JSON.stringify(structuralSignature(source)) !== JSON.stringify(structuralSignature(translated))) {
    throw new Error(`Policy structure, link, code, or identifier drift: ${context}`);
  }
  // Pinned inline code may contain CLI placeholders such as <host-id>; it is
  // independently exact-matched above and HTML-escaped by the renderer.
  const prose = translated.replace(/`[^`]+`/g, "");
  if (markdownBlocks(translated).length !== 1 || /```|~~~|<\/?[A-Za-z!]|!\[|\]\((?!\{LINK_\d+\}\))|__SITE_|__I18N_/.test(prose)) {
    throw new Error(`Unapproved markup in policy translation: ${context}`);
  }
}
