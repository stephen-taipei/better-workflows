// Build the remaining public locales of an in-code catalog from its English
// template and a reviewed overlay in docs/rc1-catalogs/site/<name>.json.
// Only leaves whose zh-Hant-TW text differs from English are translatable;
// equal leaves are identifiers, URLs or markup and stay byte-identical.
import { readFileSync } from "node:fs";

const OVERLAY_ROOT = new URL("../docs/rc1-catalogs/site/", import.meta.url);
const AUTHORED = ["en", "zh-Hant-TW"];

const escapePointer = (key) => String(key).replaceAll("~", "~0").replaceAll("/", "~1");

export function translatablePointers(english, reference, pointer = "", out = new Map()) {
  if (typeof english === "string") {
    if (typeof reference === "string" && reference !== english) out.set(pointer, english);
    return out;
  }
  if (Array.isArray(english)) {
    english.forEach((value, index) => translatablePointers(value, reference?.[index], `${pointer}/${index}`, out));
    return out;
  }
  if (english && typeof english === "object") {
    for (const key of Object.keys(english)) translatablePointers(english[key], reference?.[key], `${pointer}/${escapePointer(key)}`, out);
  }
  return out;
}

function applyOverlay(english, pointers, overlay, pointer = "") {
  if (typeof english === "string") return pointers.has(pointer) ? overlay[pointer] : english;
  if (Array.isArray(english)) return english.map((value, index) => applyOverlay(value, pointers, overlay, `${pointer}/${index}`));
  if (english && typeof english === "object") {
    return Object.fromEntries(Object.keys(english).map((key) =>
      [key, applyOverlay(english[key], pointers, overlay, `${pointer}/${escapePointer(key)}`)]));
  }
  return english;
}

export function loadLocaleOverlay(name) {
  return JSON.parse(readFileSync(new URL(`${name}.json`, OVERLAY_ROOT), "utf8"));
}

// Returns a new catalog keyed in `codes` order. The en and zh-Hant-TW entries
// must already be authored in source; every other code comes from the overlay.
export function overlayLocales(catalog, name, codes) {
  for (const code of AUTHORED) if (!Object.hasOwn(catalog, code)) throw new Error(`Locale overlay ${name} lacks authored ${code}`);
  const pointers = translatablePointers(catalog.en, catalog["zh-Hant-TW"]);
  const overlays = loadLocaleOverlay(name);
  const expected = codes.filter((code) => !AUTHORED.includes(code));
  if (JSON.stringify(Object.keys(overlays).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`Locale overlay ${name} must cover exactly the non-authored public locales`);
  }
  const result = {};
  for (const code of codes) {
    if (AUTHORED.includes(code)) { result[code] = catalog[code]; continue; }
    const overlay = overlays[code];
    const keys = Object.keys(overlay);
    if (keys.length !== pointers.size || keys.some((key) => !pointers.has(key))) {
      throw new Error(`Locale overlay ${name}/${code} does not match the translatable English leaves`);
    }
    for (const [key, english] of pointers) {
      const text = overlay[key];
      if (typeof text !== "string" || !text.trim()) throw new Error(`Empty locale overlay text: ${name}/${code}${key}`);
      // Short labels such as "Menu" or "Workflows" are legitimately shared by
      // many locales; an unchanged sentence of four or more words is not.
      const words = english.replace(/<[^>]*>|\{[^}]*\}|`[^`]*`/g, "").split(/\s+/).filter((word) => /\p{L}{3,}/u.test(word));
      if (text === english && words.length >= 4) {
        throw new Error(`English fallback in locale overlay: ${name}/${code}${key}`);
      }
    }
    result[code] = applyOverlay(catalog.en, pointers, overlay);
  }
  return result;
}
