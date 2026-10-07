import { CONNECTORS_LOCALES, DEFAULT_LOCALE, locales } from "./website-locales.mjs";

export const PUBLIC_DOC_PAGES = [
  { id: "guide", path: "docs/", reference: "index.html" },
  { id: "quick", path: "docs/quick/", reference: "preview.html" },
  { id: "use-cases", path: "docs/use-cases/", reference: "use-cases/index.html" },
  { id: "use-cases-quick", path: "docs/use-cases/quick/", reference: "use-cases/preview.html" },
  { id: "evidence-cinema", path: "docs/evidence-cinema/", reference: "evidence-cinema/index.html" }
];

export const PUBLIC_DOC_PAGE_IDS = PUBLIC_DOC_PAGES.map(({ id }) => id);

const PAGE_COPY_FIELDS = {
  guide: { title: "CONTROL_TITLE", description: "DESCRIPTION" },
  quick: { title: "QUICK_START", description: "HERO_LEAD" },
  "use-cases": { title: "DOCS_TITLE", description: "CONTROL_SUMMARY" },
  "use-cases-quick": { title: "QUICK_START", description: null },
  "evidence-cinema": { title: null, description: "CLOSING_TITLE" }
};

const PAGE_SECTION_KEYS = {
  guide: [
    ["CONTROL_TITLE", "CONTROL_SUMMARY"],
    ["DOCS_TITLE", "HERO_LEAD"],
    ["QUICK_START", "DESCRIPTION"]
  ],
  quick: [
    ["QUICK_START", "HERO_LEAD"],
    ["CONTROL_TITLE", "CONTROL_SUMMARY"],
    ["CLOSING_TITLE", "DESCRIPTION"]
  ],
  "use-cases": [
    ["DOCS_TITLE", "CONTROL_SUMMARY"],
    ["HERO_TITLE", "HERO_LEAD"]
  ],
  "use-cases-quick": [
    ["QUICK_START", "CONTROL_SUMMARY"],
    ["CONTROL_TITLE", "HERO_LEAD"],
    ["DOCS_TITLE", "CLOSING_TITLE"]
  ],
  "evidence-cinema": [
    ["CLOSING_TITLE", "HERO_LEAD"],
    ["CONTROL_TITLE", "CONTROL_SUMMARY"],
    ["DOCS_TITLE", "DESCRIPTION"]
  ]
};

export const EVIDENCE_CINEMA_TITLES = {
  ar: "سينما الأدلة",
  ca: "Cinema de l’evidència",
  cs: "Kino důkazů",
  da: "Evidensbiografen",
  de: "Nachweiskino",
  el: "Κινηματογράφος τεκμηρίων",
  en: "Evidence Cinema",
  es: "Cine de la evidencia",
  "es-MX": "Cine de la evidencia",
  fi: "Evidenssielokuva",
  fil: "Sine ng ebidensya",
  fr: "Cinéma des preuves",
  he: "קולנוע הראיות",
  hi: "साक्ष्य सिनेमा",
  hr: "Kino dokaza",
  hu: "Bizonyítékmozi",
  id: "Sinema Bukti",
  it: "Cinema delle evidenze",
  ja: "エビデンス・シネマ",
  km: "រោងកុនភស្តុតាង",
  ko: "증거 시네마",
  lo: "ຮູບເງົາຫຼັກຖານ",
  ms: "Pawagam Bukti",
  my: "အထောက်အထား ရုပ်ရှင်ရုံ",
  nb: "Evidenskino",
  nl: "Bewijscinema",
  pl: "Kino dowodów",
  pt: "Cinema de evidências",
  "pt-BR": "Cinema de evidências",
  ro: "Cinema dovezilor",
  ru: "Кино доказательств",
  sk: "Kino dôkazov",
  sv: "Evidensbio",
  th: "โรงภาพยนตร์หลักฐาน",
  tr: "Kanıt Sineması",
  uk: "Кіно доказів",
  vi: "Rạp chiếu bằng chứng",
  "zh-Hans": "证据剧场",
  "zh-Hant": "證據劇場",
  "zh-Hant-HK": "證據劇場",
  "zh-Hant-TW": "證據劇場"
};

export function localePrefix(code) {
  return code === DEFAULT_LOCALE ? "/" : `/${code}/`;
}

export function homepagePath(code) {
  return localePrefix(code);
}

export function publicDocPath(code, pageId) {
  const page = PUBLIC_DOC_PAGES.find(({ id }) => id === pageId);
  if (!page) throw new Error(`Unknown public documentation page: ${pageId}`);
  return `${localePrefix(code)}${page.path}`;
}

export function publicReferencePath(code, pageId) {
  const page = PUBLIC_DOC_PAGES.find(({ id }) => id === pageId);
  if (!page) throw new Error(`Unknown public documentation page: ${pageId}`);
  return `/docs/reference/${code}/${page.reference}`;
}

export function publicDocCopy(locale, pageId) {
  const page = PUBLIC_DOC_PAGES.find(({ id }) => id === pageId);
  const fields = PAGE_COPY_FIELDS[pageId];
  if (!page || !fields) throw new Error(`Unknown public documentation page: ${pageId}`);
  const messages = locale.messages;
  const title = pageId === "evidence-cinema"
    ? EVIDENCE_CINEMA_TITLES[locale.code]
    : pageId === "use-cases-quick"
      ? `${messages.QUICK_START} — ${messages.DOCS_TITLE}`
      : messages[fields.title];
  const description = pageId === "use-cases-quick"
    ? `${messages.QUICK_START}: ${messages.CONTROL_SUMMARY}`
    : messages[fields.description];
  return {
    title,
    description,
    referencePath: publicReferencePath(locale.code, pageId)
  };
}

export function publicDocSections(locale, pageId) {
  const keys = PAGE_SECTION_KEYS[pageId];
  if (!keys) throw new Error(`Unknown public documentation page: ${pageId}`);
  return keys.map(([titleKey, descriptionKey]) => ({
    title: locale.messages[titleKey],
    description: locale.messages[descriptionKey]
  }));
}

export function publicDocCards(locale) {
  return PUBLIC_DOC_PAGES.map((page) => ({
    ...page,
    ...publicDocCopy(locale, page.id),
    path: publicDocPath(locale.code, page.id)
  }));
}

export const UNNATURAL_EVIDENCE_PATTERNS = {
  ar: [/أدل(?:ة|ه) طازجة/u],
  ca: [/evidència fresca/iu],
  cs: [/čerstv(?:é|á) důkaz/iu],
  da: [/frisk evidens/iu],
  de: [/frische (?:Beweise|Nachweise|Evidenz)/iu],
  el: [/φρέσκ(?:α|ες) (?:στοιχεία|αποδείξεις)/iu],
  es: [/evidencia fresca/iu],
  "es-MX": [/evidencia fresca/iu],
  fi: [/tuore (?:näyttö|todiste)/iu],
  fil: [/sariwang ebidensya/iu],
  fr: [/(?:preuve|preuves) fraîche/iu],
  he: [/ראיות טריות/u],
  hi: [/ताज़ा (?:साक्ष्य|सबूत)/u],
  hr: [/svjež(?:i|e) dokaz/iu],
  hu: [/friss bizonyíték/iu],
  id: [/bukti segar/iu],
  it: [/(?:prova|prove) fresc/iu],
  ja: [/新鮮な(?:証拠|エビデンス|evidence)/iu],
  km: [/ភស្តុតាងស្រស់/u],
  ko: [/신선한\s*(?:증거|evidence)/iu],
  lo: [/ຫຼັກຖານສົດ/u],
  ms: [/bukti segar/iu],
  my: [/လတ်ဆတ်သော\s*အထောက်အထား/u],
  nb: [/ferske? bevis/iu],
  nl: [/vers(?:e)? bewijs/iu],
  pl: [/śwież(?:e|ych) dowod/iu],
  pt: [/evidência fresca/iu],
  "pt-BR": [/evidência fresca/iu],
  ro: [/dovezi proaspete/iu],
  ru: [/свежие доказательства/iu],
  sk: [/čerstv(?:é|á) dôkaz/iu],
  sv: [/färska bevis/iu],
  th: [/หลักฐานสด/u],
  tr: [/taze kanıt/iu],
  uk: [/свіжі докази/iu],
  vi: [/bằng chứng tươi/iu],
  "zh-Hans": [/新鲜(?:的)?证据/u],
  "zh-Hant": [/新鮮(?:的)?證據/u],
  "zh-Hant-HK": [/新鮮(?:嘅|的)?證據/u],
  "zh-Hant-TW": [/新鮮(?:的)?證據/u]
};

if (JSON.stringify(locales.map(({ code }) => code)) !== JSON.stringify(CONNECTORS_LOCALES)) {
  throw new Error("Public documentation locale order must match the Connectors iOS inventory");
}
if (JSON.stringify(Object.keys(EVIDENCE_CINEMA_TITLES).sort()) !== JSON.stringify([...CONNECTORS_LOCALES].sort())) {
  throw new Error("Evidence Cinema title localization must cover the Connectors iOS inventory");
}
if (JSON.stringify(Object.keys(UNNATURAL_EVIDENCE_PATTERNS).sort()) !== JSON.stringify(CONNECTORS_LOCALES.filter((code) => code !== "en").sort())) {
  throw new Error("Unnatural evidence terminology audit must cover every non-English locale");
}
