import { localizedOverviewLabel } from "./reference-copy.mjs";

// These reference guides contain runtime identifiers, security contracts, and
// executable examples. Until a real translation catalog exists, preserve the
// canonical body byte-for-byte instead of fabricating prose from generic UI
// strings. Only headings and the explicit locale overview label are localized.
// This is deliberately conservative: structural parity is useful evidence, but
// it is not evidence that the body has been translated.

function localizeHeading(source, headingMap) {
  const translated = headingMap.get(source);
  if (!translated) return source;
  if (translated.startsWith("#")) return translated;
  const level = source.match(/^(#{1,6})\s+/)?.[1] || "#";
  return `${level} ${translated}`;
}

function localizeOverviewLink(source, code) {
  return source.replace(
    /^\[41-locale localized overview and official web entry points\]\(\{LINK_0\}\)/,
    `[${localizedOverviewLabel(code)}]({LINK_0})`
  );
}

export function localizeReferenceBlock(source, code, _messages, { headingMap = new Map() } = {}) {
  if (/^#{1,6}\s+/.test(source)) return localizeHeading(source, headingMap);
  if (source.startsWith("[41-locale localized overview and official web entry points]")) return localizeOverviewLink(source, code);
  return source;
}

export function localizeReferenceTexts(source, code, messages, options = {}) {
  if (code === "en") return source.texts;
  if (source.bodyTranslations?.[code]) return [...source.bodyTranslations[code].texts];
  return source.texts.map((text) => localizeReferenceBlock(text, code, messages, options));
}

export function localizeMermaidCode(source, code, labels) {
  // Untranslated references retain the exact diagram. Generic CTA/closing
  // copy must never replace "unknown" or "stale / missing" control labels.
  if (code === "en" || !labels || !source.startsWith("```mermaid\n")) return source;
  return source.replace(/"([^"]+)"/g, (_whole, label) => {
    if (!Object.hasOwn(labels, label)) throw new Error(`Missing reference diagram label: ${code}/${label}`);
    return `"${labels[label]}"`;
  });
}
