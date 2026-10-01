import { CONNECTORS_LOCALES } from './website-locales.mjs';
import { PUBLIC_DOC_PAGES } from './public-docs.mjs';
import { loadAutoPublicDocs, autoPublicDocsCoverage, renderAutoPublicDocs } from './auto-public-docs.mjs';
import { loadEvidenceCinema, evidenceCinemaCoverage, renderEvidenceCinemaHtml } from './interactive-evidence-cinema.mjs';

// The builder and coverage reporter share the real body renderers. A declared
// locale route alone is not evidence that a complete body can be rendered.
export const INTERACTIVE_DOCUMENT_ADAPTERS = Object.freeze(Object.fromEntries([
  ['guide', loadAutoPublicDocs, autoPublicDocsCoverage, (guide, code) => renderAutoPublicDocs(guide, code, 'guide')],
  ['quick', loadAutoPublicDocs, autoPublicDocsCoverage, (guide, code) => renderAutoPublicDocs(guide, code, 'quick')],
  ['use-cases', loadAutoPublicDocs, autoPublicDocsCoverage, (guide, code) => renderAutoPublicDocs(guide, code, 'use-cases')],
  ['use-cases-quick', loadAutoPublicDocs, autoPublicDocsCoverage, (guide, code) => renderAutoPublicDocs(guide, code, 'use-cases-quick')],
  ['evidence-cinema', loadEvidenceCinema, evidenceCinemaCoverage, renderEvidenceCinemaHtml]
].map(([id, load, coverage, render]) => [id, Object.freeze({ load, coverage, render, publicRouteIntegrated: true })])));

export function renderInteractiveDocumentPages(documents) {
  const expected = PUBLIC_DOC_PAGES.map(page => page.id);
  if (!(documents instanceof Map) || JSON.stringify([...documents.keys()]) !== JSON.stringify(expected)) {
    throw new Error('Interactive document build: exact five-document inventory required');
  }
  const prepared = new Map();
  for (const id of expected) {
    const guide = documents.get(id), adapter = INTERACTIVE_DOCUMENT_ADAPTERS[id];
    // Each production renderer revalidates complete catalog/source binding.
    // Do not return any partial result if a later locale or document fails.
    const pages = new Map(CONNECTORS_LOCALES.map(code => [code, adapter.render(guide, code)]));
    prepared.set(id, { guide, pages });
  }
  return prepared;
}

export async function loadInteractiveDocumentPages(repositoryRoot) {
  const documents = new Map();
  for (const { id } of PUBLIC_DOC_PAGES) {
    documents.set(id, await INTERACTIVE_DOCUMENT_ADAPTERS[id].load(repositoryRoot, { requireComplete: true }));
  }
  // No filesystem mutation occurs here. Callers must finish this preflight
  // before creating/replacing any public build output.
  return renderInteractiveDocumentPages(documents);
}
