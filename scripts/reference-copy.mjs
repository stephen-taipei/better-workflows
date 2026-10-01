import { CONNECTORS_LOCALES } from "./website-locales.mjs";

// Keep the RC1 overview link label shared by generated guides and locale tests.
// It identifies the two planned public routes without implying full-body review.
export const LOCALE_OVERVIEW_LABELS = Object.freeze({
  "zh-Hant-TW": "RC1 雙語公開總覽與官網入口（41 語系來源目錄為私有）",
});

// State the actual reference-body coverage in the reader's language.
export const REFERENCE_CONTENT_NOTICES = Object.freeze({
  "en": "This reference page has a localized overview; its interactive content is not fully translated across all locales.",
  "zh-Hant-TW": "此參考頁已提供本語系摘要；互動內容尚未完整翻譯。",
});

if (Object.keys(REFERENCE_CONTENT_NOTICES).join() !== CONNECTORS_LOCALES.join()) throw new Error("Reference notice locale coverage/order drift");
if (Object.keys(LOCALE_OVERVIEW_LABELS).join() !== CONNECTORS_LOCALES.filter((code) => code !== "en").join()) throw new Error("Locale overview label coverage/order drift");
export function referenceContentNotice(code) {
  if (!Object.hasOwn(REFERENCE_CONTENT_NOTICES, code)) throw new Error(`Unsupported reference notice locale: ${code}`);
  return REFERENCE_CONTENT_NOTICES[code];
}
export function localizedOverviewLabel(code) {
  if (!Object.hasOwn(LOCALE_OVERVIEW_LABELS, code)) throw new Error(`Unsupported locale overview label: ${code}`);
  return LOCALE_OVERVIEW_LABELS[code];
}
