#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CONNECTORS_LOCALES } from "./website-locales.mjs";
import { SUPPORT_KEYS, SUPPORT_SOURCE, renderSupportMarkdown, supportCopy, supportMarkdownPath, verifySupportSource } from "./localized-support.mjs";
import { renderPolicyMarkdown } from "./localized-policies.mjs";
import { loadPublicTexts } from "./localized-public-text.mjs";
import { publicTextMarkdownPath as policyMarkdownPath } from "./policy-routes.mjs";
import { PUBLIC_TEXT_SPECS } from "./public-text-source.mjs";
import { loadAutoPublicDocs, autoPublicDocsCoverage } from "./auto-public-docs.mjs";
import { publicDocPath } from "./public-docs.mjs";
import { referenceBodyCoverage } from "./reference-body-catalog.mjs";
import { INTERACTIVE_DOCUMENT_ADAPTERS } from "./interactive-document-build.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const overviewPaths = new Set(CONNECTORS_LOCALES.map((code) => `docs/locales/${code}.md`));
const generatedDetailCodes = CONNECTORS_LOCALES.filter((code) => !["en", "ja", "ko"].includes(code));
const generatedDetailPaths = new Set(generatedDetailCodes.map((code) => `docs/details/${code}.md`));
const translationPaths = new Set(CONNECTORS_LOCALES.flatMap((code) => [supportMarkdownPath(code), ...PUBLIC_TEXT_SPECS.map((policy) => policyMarkdownPath(code, policy.id))]));
const dynamicTemplatePaths = new Set([
  "scripts/templates/localized-homepage.html",
  "scripts/templates/localized-doc-page.html",
  "website/404.html"
]);
const auditArtifactPaths = new Set([
  "docs/localization-branch-audit.md"
]);

const STAGED_INTERACTIVE_SPECS = Object.freeze([
  { path: "docs/html/evidence-cinema/index.html", pageId: "evidence-cinema" }
]);

const stagedInteractiveSpec = (file) => STAGED_INTERACTIVE_SPECS.find((item) => item.path === file);
async function stagedInteractiveCoverage(repositoryRoot, spec, publicLocaleIds) {
  const source = await readFile(path.join(repositoryRoot, spec.path), "utf8");
  const adapter = INTERACTIVE_DOCUMENT_ADAPTERS[spec.pageId];
  const guide = adapter ? await adapter.load(repositoryRoot, { requireComplete: false }) : null;
  // The shared registry binds builder wiring; catalog completeness remains a
  // separate prerequisite and neither establishes deployment or meaning.
  const completeBodyDraft = guide?.status.complete === true && adapter.publicRouteIntegrated === true;
  const bodyDraftCoverage = guide
    ? adapter.coverage(guide, { publicRouteIntegrated: completeBodyDraft }) : null;
  const buttons = [...source.matchAll(/<a\b[^>]*data-locale-button="([^"]+)"[^>]*data-locale-static="true"[^>]*href="([^"]+)"[^>]*>/g)]
    .map((match) => ({ code: match[1], href: match[2] }));
  const expectedRoutes = CONNECTORS_LOCALES.map((code) => publicDocPath(code, spec.pageId));
  const actualCodes = buttons.map(({ code }) => code);
  const actualRoutes = buttons.map(({ href }) => href);
  if (JSON.stringify(actualCodes) !== JSON.stringify(CONNECTORS_LOCALES)) {
    throw new Error(`Staged interactive locale button drift: ${spec.path}`);
  }
  if (JSON.stringify(actualRoutes) !== JSON.stringify(expectedRoutes)) {
    throw new Error(`Staged interactive locale route drift: ${spec.path}`);
  }
  return {
    path: spec.path,
    sourceSha256: sha256(source),
    pageId: spec.pageId,
    localeCount: publicLocaleIds.length,
    staticLocaleButtonCount: buttons.length,
    routeCount: actualRoutes.length,
    catalogedLocales: actualCodes,
    publicLocaleIds,
    missingLocales: [],
    fullTextParity: completeBodyDraft ? "complete-draft-pending-review" : "partial-reference-body",
    bodyStatus: completeBodyDraft ? "complete-translated-draft-pending-semantic-review" : "source-owned-interactive-body-not-fully-translated",
    ...(bodyDraftCoverage ? { bodyDraftCoverage } : {}),
    ...(completeBodyDraft ? { draftEditions: publicLocaleIds.map((code) => ({ code,
      path: `${publicDocPath(code, spec.pageId).slice(1)}index.html`, format: "html",
      sha256: sha256(adapter.render(guide, code)), segmentCount: guide.source.keys.length })) } : {}),
    publicRouteIntegration: "build-integrated-not-deployment-proof",
    nativeSpeakerReview: "not-established",
    verification: completeBodyDraft
      ? "All in-scope full-body drafts are rendered from the pinned catalog. Built-byte parity is checked separately; semantic review, indexability and deployment are not established."
      : "Every requested locale has a visible static button and locale-bound route; the embedded interactive prose remains source-owned and is not counted as a complete translation."
  };
}

async function dynamicTemplateCoverage(repositoryRoot, file) {
  const source = await readFile(path.join(repositoryRoot, file), "utf8");
  if (file === "website/404.html") {
    if (!source.includes('lang="en"') || !source.includes('找不到這個頁面')) throw new Error('404 requires a bilingual recovery message');
    return { path: file, sourceSha256: sha256(source), localeCount: CONNECTORS_LOCALES.length,
      fullTextParity: "bilingual-static-recovery-page", verification: "Bilingual recovery text with the shared public navigation; locale links lead to the corresponding homepage." };
  }
  const requiredTokens = ["__SITE_LOCALE_OPTIONS__", "__SITE_LOCALE_LINKS__", "__SITE_LOCALE_BUTTONS__"];
  for (const token of requiredTokens) if (!source.includes(token)) throw new Error(`Dynamic locale template token missing: ${file}/${token}`);
  return {
    path: file,
    sourceSha256: sha256(source),
    localeCount: CONNECTORS_LOCALES.length,
    fullTextParity: file === "scripts/templates/localized-doc-page.html" ? "retired-reference-shell-template" : "runtime-catalog-injected",
    verification: file === "scripts/templates/localized-doc-page.html"
      ? "Retained legacy shell, unused by the five-document full-body builder; not a translated body or delivery proof."
      : "Rendered in-scope locale copy is verified by website and localization tests; the template contains no standalone locale body."
  };
}

async function auditArtifactCoverage(repositoryRoot, file) {
  const source = await readFile(path.join(repositoryRoot, file), "utf8");
  return {
    path: file,
    sourceSha256: sha256(source),
    classification: "read-only-audit-metadata",
    verification: "Records a dated observation and is not a translated public content body."
  };
}

export function isRegisteredGeneratedLocalePath(file) {
  return overviewPaths.has(file) || generatedDetailPaths.has(file) || translationPaths.has(file);
}

async function localizedDetailEntryCoverage(repositoryRoot, file) {
  const code = file.slice("docs/details/".length, -".md".length);
  const source = await readFile(path.join(repositoryRoot, file), "utf8");
  const languageLinks = [...source.matchAll(/\[[^\]]+\]\(([^)]+\.md)\)/g)].map((match) => match[1]);
  const requiredGuides = ["getting-started", "workflows", "architecture", "security-guide", "cli-reference"]
    .map((guide) => `../locales/${code}/${guide}.md`);
  if (!source.includes("# Better Workflows") || requiredGuides.some((target) => !source.includes(`](${target})`))) {
    throw new Error(`Localized detail entry is incomplete: ${file}`);
  }
  return {
    path: file,
    locale: code,
    languageLinkCount: languageLinks.length,
    localizedGuideCount: requiredGuides.length,
    fullTextParity: "localized-entry-not-full-body",
    nativeSpeakerReview: "not-established",
    verification: "A locale-bound public entry links the complete same-locale guide set; legacy detail-body parity is tracked separately and is not claimed."
  };
}

export async function publicContentCoverage(repositoryRoot = root, { localeIds = CONNECTORS_LOCALES, allowMissingGenerated = false } = {}) {
  if (!Array.isArray(localeIds) || localeIds.length === 0 || new Set(localeIds).size !== localeIds.length ||
      localeIds.some((code) => !CONNECTORS_LOCALES.includes(code))) {
    throw new Error("Public content coverage locale scope is invalid");
  }
  await verifySupportSource(repositoryRoot);
  const policies = await loadPublicTexts(repositoryRoot);
  const auto = await loadAutoPublicDocs(repositoryRoot);
  const mappedPaths = [SUPPORT_SOURCE.path, ...policies.map((policy) => policy.source)];
  const verifiedPaths = [SUPPORT_SOURCE.path, ...policies.filter((policy) => policy.translationMode !== "canonical-english-body").map((policy) => policy.source)];
  // A conservative inventory: do not silently exempt policy/operations/plugin prose.
  // Unclassified tracked Markdown/HTML remains unassessed, never implicitly complete.
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--", "*.md", "*.html"],
    { cwd: repositoryRoot, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 8 * 1024 * 1024 });
  const files = stdout.split("\0").filter(Boolean).sort();
  const sources = [];
  const dynamicTemplates = [];
  const auditArtifacts = [];
  const stagedInteractiveDocuments = [];
  const localizedDetailEntries = [];
  for (const file of files) {
    if (generatedDetailPaths.has(file)) {
      localizedDetailEntries.push(await localizedDetailEntryCoverage(repositoryRoot, file));
      continue;
    }
    if (isRegisteredGeneratedLocalePath(file)) continue;
    const interactiveSpec = stagedInteractiveSpec(file);
    if (interactiveSpec) {
      stagedInteractiveDocuments.push(await stagedInteractiveCoverage(repositoryRoot, interactiveSpec, localeIds));
      continue;
    }
    if (dynamicTemplatePaths.has(file)) {
      dynamicTemplates.push(await dynamicTemplateCoverage(repositoryRoot, file));
      continue;
    }
    if (auditArtifactPaths.has(file)) {
      auditArtifacts.push(await auditArtifactCoverage(repositoryRoot, file));
      continue;
    }
    sources.push({ path: file, sourceSha256: sha256(await readFile(path.join(repositoryRoot, file))),
      fullTextParity: verifiedPaths.includes(file) ? "verified" : mappedPaths.includes(file) ? "partial-reference-body" : "not-assessed",
      nativeSpeakerReview: "not-established" });
  }
  for (const file of mappedPaths) if (!sources.some((item) => item.path === file)) throw new Error(`Canonical ${file} missing from source inventory`);
  const editions = [];
  for (const code of localeIds) {
    const target = supportMarkdownPath(code);
    const expected = renderSupportMarkdown(code);
    const bytes = await readFile(path.join(repositoryRoot, target), "utf8").catch((error) => {
      if (allowMissingGenerated && error?.code === "ENOENT") return null;
      throw error;
    });
    if (bytes !== null && bytes !== expected) throw new Error(`Support edition body drift: ${code}`);
    editions.push({ code, path: target, sourcePresent: bytes !== null, sha256: sha256(bytes ?? expected),
      segmentCount: Object.keys(supportCopy[code]).length });
  }
  const documents = [{ ...SUPPORT_SOURCE, fullTextParity: "verified", segmentCount: SUPPORT_KEYS.length, editions }];
  for (const policy of policies) {
    const policyEditions = [];
    for (const code of localeIds) {
      const target = policyMarkdownPath(code, policy.id);
      const expected = renderPolicyMarkdown(policy, code);
      const bytes = await readFile(path.join(repositoryRoot, target), "utf8").catch((error) => {
        if (allowMissingGenerated && error?.code === "ENOENT") return null;
        throw error;
      });
      if (bytes !== null && bytes !== expected) throw new Error(`Policy edition body drift: ${code}/${policy.id}`);
      policyEditions.push({ code, path: target, sourcePresent: bytes !== null, sha256: sha256(bytes ?? expected), segmentCount: policy.texts.length });
    }
    documents.push({ path: policy.source, sha256: policy.sha256, segmentCount: policy.texts.length,
      fullTextParity: policy.translationMode === "canonical-english-body" ? "partial-reference-body" : "verified",
      kind: policy.kind || "policy",
      fixedCodeBlockCount: policy.blocks.filter((block) => block.type === "code").length,
      fixedReferenceListCount: policy.blocks.filter((block) => block.type === "reference-links").length,
      fixedProperNameHeadingCount: policy.blocks.filter((block) => block.type === "fixed-heading").length,
      localizedDiagramCount: policy.blocks.filter((block) => block.type === "workflow-diagram").length,
      localizedDiagramLabelCount: policy.blocks.filter((block) => block.type === "workflow-diagram").reduce((sum, block) => sum + block.indices.length, 0),
      ...(policy.sourceRevision !== undefined ? { sourceRevision: policy.sourceRevision, sourceStatus: policy.sourceStatus } : {}),
      ...(policy.upstreamSourceSha256 ? { upstreamSourceSha256: policy.upstreamSourceSha256, editorialCorrection: policy.editorialCorrection } : {}),
      editions: policyEditions });
  }
  return {
    schemaVersion: 1,
    scope: "All tracked Markdown and HTML prose sources, excluding generated locale overviews, registered translated editions, runtime templates, and explicitly classified read-only audit metadata. Dynamic templates and audit metadata are reported separately; unclassified prose remains unassessed.",
    locales: localeIds,
    fullContentLocalizationComplete: sources.length > 0 && sources.every((item) => item.fullTextParity === "verified") &&
      stagedInteractiveDocuments.every((item) => item.fullTextParity === "verified"),
    nativeSpeakerReview: "not-established",
    coverageEvidence: allowMissingGenerated
      ? "Canonical source mapping for requested locales; generated Markdown parity is checked when present and absence is recorded per edition. Website tests compare deterministic built HTML bytes. Not proof of translated meaning, native-speaker quality or deployment."
      : "Complete canonical English mapping, exact generated Markdown parity and deterministic full HTML projection; website tests compare built bytes. Not proof of translated meaning, native-speaker quality or deployment.",
    fullTextParityVerifiedSources: verifiedPaths,
    sourceMappingVerifiedSources: mappedPaths,
    referenceDocuments: policies.filter((policy) => policy.translationMode === "canonical-english-body").map((policy) => ({
      path: policy.source,
      sourceSha256: policy.sha256,
      segmentCount: policy.texts.length,
      editions: localeIds.map((code) => ({ code, ...referenceBodyCoverage(policy, code) })),
      translatedLocaleCount: localeIds.filter((code) => referenceBodyCoverage(policy, code).translated).length,
      remainingTranslationLocales: localeIds.filter((code) => code !== "en" && !referenceBodyCoverage(policy, code).translated),
      semanticReview: "not-established",
      indexable: false
    })),
    stagedInteractiveDocuments,
    dynamicTemplates,
    auditArtifacts,
    localizedDetailEntries,
    interactiveDocuments: [autoPublicDocsCoverage(auto, { publicRouteIntegrated: true })],
    unassessedSourceCount: sources.filter((item) => item.fullTextParity === "not-assessed").length,
    overviewFilesNotCountedAsFullText: files.filter((file) => overviewPaths.has(file)),
    sources,
    documents
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--json", "--require-complete"].includes(arg))) throw new Error("Usage: public-content-coverage.mjs [--json] [--require-complete]");
  const report = await publicContentCoverage();
  const unassessedSources = report.sources.filter((item) => item.fullTextParity === "not-assessed").map((item) => item.path);
  console.log(JSON.stringify(args.includes("--json") ? report : {
    fullContentLocalizationComplete: report.fullContentLocalizationComplete,
    fullTextParityVerifiedSources: report.fullTextParityVerifiedSources,
    sourceMappedEditions: report.documents.reduce((count, doc) => count + doc.editions.length, 0),
    fullTextEditions: report.documents.filter((doc) => doc.fullTextParity === "verified").reduce((count, doc) => count + doc.editions.length, 0),
    referenceDocuments: report.referenceDocuments,
    interactiveDocuments: report.interactiveDocuments,
    stagedInteractiveDocuments: report.stagedInteractiveDocuments.map((document) => ({
      source: document.source, catalogedLocales: document.catalogedLocales.length,
      missingLocales: document.missingLocales.length, fullTextParity: document.fullTextParity,
      publicRouteIntegration: document.publicRouteIntegration
    })),
    localizedDetailEntries: report.localizedDetailEntries,
    unassessedSourceCount: report.unassessedSourceCount,
    unassessedSources,
    auditArtifacts: report.auditArtifacts,
    nativeSpeakerReview: report.nativeSpeakerReview
  }, null, 2));
  if (args.includes("--require-complete") && !report.fullContentLocalizationComplete) process.exitCode = 1;
}
