import { overlayLocales } from "./locale-overlay.mjs";

export const LOCALE_KEYS = [
  "TITLE",
  "DESCRIPTION",
  "SKIP",
  "MENU",
  "LANGUAGE",
  "HERO_TITLE",
  "HERO_ACCENT",
  "HERO_LEAD",
  "DOCS_CTA",
  "GITHUB_CTA",
  "CONTROL_TITLE",
  "CONTROL_SUMMARY",
  "QUICK_START",
  "DOCS_TITLE",
  "CLOSING_TITLE",
  "THEME_LIGHT",
  "THEME_DARK",
  "V4_POSITIONING",
  "V4_RISK_LEAD",
  "V4_SUMMARY",
  "V4_AUTO_FLOW",
  "V4_RECOMMENDED",
  "V4_BOUNDARIES",
  "V4_CLAIM_LIMIT",
  "SPONSOR_CTA",
  "SPONSOR_TITLE",
  "SPONSOR_BODY"
];

export const CONNECTORS_LOCALES = ["en", "zh-Hant", "zh-Hant-TW", "zh-Hant-HK", "zh-Hans", "vi", "uk", "tr", "th", "sv", "sk", "ru", "ro", "pt", "pt-BR", "pl", "nl", "nb", "my", "ms", "lo", "ko", "km", "ja", "it", "id", "hu", "hr", "hi", "he", "fr", "fil", "fi", "es", "es-MX", "el", "de", "da", "cs", "ca", "ar"];

// Every public locale has a site, document and support edition. The name is
// kept for existing consumers of the RC1 public locale contract.
export const PUBLIC_RC1_LOCALE_IDS = Object.freeze([...CONNECTORS_LOCALES]);

const LOCALE_LABELS = {
  "en": "English",
  "zh-Hant": "繁體中文",
  "zh-Hant-TW": "繁體中文（台灣）",
  "zh-Hant-HK": "繁體中文（香港）",
  "zh-Hans": "简体中文",
  "vi": "Tiếng Việt",
  "uk": "Українська",
  "tr": "Türkçe",
  "th": "ไทย",
  "sv": "Svenska",
  "sk": "Slovenčina",
  "ru": "Русский",
  "ro": "Română",
  "pt": "Português",
  "pt-BR": "Português (Brasil)",
  "pl": "Polski",
  "nl": "Nederlands",
  "nb": "Norsk bokmål",
  "my": "မြန်မာ",
  "ms": "Bahasa Melayu",
  "lo": "ລາວ",
  "ko": "한국어",
  "km": "ខ្មែរ",
  "ja": "日本語",
  "it": "Italiano",
  "id": "Bahasa Indonesia",
  "hu": "Magyar",
  "hr": "Hrvatski",
  "hi": "हिन्दी",
  "he": "עברית",
  "fr": "Français",
  "fil": "Filipino",
  "fi": "Suomi",
  "es": "Español",
  "es-MX": "Español (México)",
  "el": "Ελληνικά",
  "de": "Deutsch",
  "da": "Dansk",
  "cs": "Čeština",
  "ca": "Català",
  "ar": "العربية"
};

export const DEFAULT_LOCALE = "zh-Hant-TW";

const authoredLocales = [
  {
    code: "en", label: "English", messages: {
      TITLE: "Better Workflows | Provable agent workflows",
      DESCRIPTION: "Better Workflows V5.0 RC1 is publicly available: a free, open-source Auto workflow for AI engineering QA and delivery, with current evidence, review gates, and provider reconciliation.",
      SKIP: "Skip to main content", MENU: "Menu", LANGUAGE: "Language",
      HERO_TITLE: "Take agent work", HERO_ACCENT: "to a provable finish.",
      HERO_LEAD: "V5.0 RC1 is publicly available. Auto checks the goal, scope, repository, and risk, then selects targeted checks or an evidence workflow. Git changes use a task-owned worktree; delivery requires authorization and a verified external outcome.",
      DOCS_CTA: "Explore the documentation", GITHUB_CTA: "Open GitHub",
      CONTROL_TITLE: "Four explicit boundaries from intent to completion.",
      CONTROL_SUMMARY: "Define the contract, verify source and evidence, reconcile external effects, and declare completion only when the terminal state is known.",
      QUICK_START: "Quick start", DOCS_TITLE: "Move from the architecture map to practical use cases.",
      CLOSING_TITLE: "Running a command is not proof of completion; a re-verifiable outcome is.",
      THEME_LIGHT: "Switch to light theme", THEME_DARK: "Switch to dark theme"
    }
  },
  {
    code: "zh-Hant-TW", label: "繁體中文（台灣）", messages: {
      TITLE: "Better Workflows｜讓 agent 工作完成且可驗證",
      DESCRIPTION: "Better Workflows V5.0 RC1 已公開上架：免費開源的 AI 工程 QA 與交付守門人，以 Auto 入口、有效證據、審查關卡與外部狀態核對，確保結果可重新驗證。",
      SKIP: "跳到主要內容", MENU: "選單", LANGUAGE: "語言",
      HERO_TITLE: "讓 agent 工作", HERO_ACCENT: "完成，並留下可驗證的結果。",
      HERO_LEAD: "V5.0 RC1 已公開上架。Auto 先檢查目標、範圍、儲存庫與風險，再選擇精簡檢查或證據流程。Git 修改使用專屬 worktree；交付必須有授權，並核對外部結果。",
      DOCS_CTA: "查看官方文件", GITHUB_CTA: "開啟 GitHub",
      CONTROL_TITLE: "從意圖到完成，明確劃分四道邊界。",
      CONTROL_SUMMARY: "先定義 contract，再驗證 source 與 evidence、核對外部操作結果；只有 terminal state 已知時，才宣告完成。",
      QUICK_START: "快速開始", DOCS_TITLE: "從架構地圖繼續深入實際使用情境。",
      CLOSING_TITLE: "命令成功執行不代表工作已經完成；可重新驗證的結果才是證明。",
      THEME_LIGHT: "切換淺色模式", THEME_DARK: "切換深色模式"
    }
  }
];
const siteMessages = overlayLocales(Object.fromEntries(authoredLocales.map(({ code, messages }) => [code, messages])),
  "site-messages", CONNECTORS_LOCALES);
export const locales = CONNECTORS_LOCALES.map((code) => ({ code, label: LOCALE_LABELS[code], messages: { ...siteMessages[code] } }));

const v5ProductCopy = overlayLocales({
  en: {
    eyebrow: "V5.0 RC1 · Public release and licensing",
    title: "V5.0 RC1 is publicly available. GA remains pending.",
    boundary: "V5.0 RC1 (5.0.0-rc.1, tag V5.0.rc1) is a controlled prerelease with one public Auto entrypoint. The V4 support matrix remains historical; RC1 does not establish GA acceptance or V5 completion.",
    scope: "V5.0 RC1 covers Codex, Gemini CLI, and Qwen Code on macOS × Node 22/24. Claude Code, Linux, and Windows qualification is deferred to V5.1. GA requires at least 30 natural canary days, 20 consecutive eligible starts, and three distinct repositories.",
    license: "The first-party Better Workflows core is AGPL-3.0-only. The physically separate minimal wire package is Apache-2.0; its LICENSE and NOTICE apply to that package.",
    plan: "The basic product is free. Professional Pack is planned as a proprietary product, and Cloud is a separate product planned for later; neither is currently available."
  },
  "zh-Hant-TW": {
    eyebrow: "V5.0 RC1 · 公開上架與授權",
    title: "V5.0 RC1 已公開上架，GA 仍待完成。",
    boundary: "V5.0 RC1（5.0.0-rc.1，tag V5.0.rc1）是受控預發行版本，公開入口僅有 Auto。V4 支援矩陣仍屬歷史文件範圍；RC1 不代表 GA 驗收或 V5 全面完成。",
    scope: "V5.0 RC1 涵蓋 macOS × Node 22/24 上的 Codex、Gemini CLI 與 Qwen Code。Claude Code、Linux 與 Windows 的驗收延至 V5.1。GA 仍需至少 30 個自然 canary 日、20 次連續符合資格的啟動，以及三個不同儲存庫。",
    license: "第一方 Better Workflows 核心採 AGPL-3.0-only。實體獨立的 minimal wire package 另採 Apache-2.0；其 LICENSE 與 NOTICE 適用於該 package。",
    plan: "基本產品免費。Professional Pack 規劃為專有產品，Cloud 是後續獨立產品；兩者目前尚未提供。"
  }
}, "v5-product-copy", CONNECTORS_LOCALES);

const V5_PRODUCT_FIELDS = ["eyebrow", "title", "boundary", "scope", "license", "plan"];
const V5_PRODUCT_MARKERS = {
  boundary: ["V4", "V5"],
  scope: ["V5.0", "V5.1", "macOS", "Node 22/24", "Linux", "Windows", "Claude Code"],
  license: ["AGPL-3.0-only", "Apache-2.0", "LICENSE", "NOTICE"],
  plan: ["Professional Pack", "Cloud"]
};
const v5ProductCodes = Object.keys(v5ProductCopy);
if (v5ProductCodes.length !== CONNECTORS_LOCALES.length || CONNECTORS_LOCALES.some((code) => !Object.hasOwn(v5ProductCopy, code))) {
  throw new Error("V5 product copy must cover every public locale exactly once");
}
for (const locale of locales) {
  const copy = v5ProductCopy[locale.code];
  if (!copy || V5_PRODUCT_FIELDS.some((field) => typeof copy[field] !== "string" || copy[field].trim() === "")) {
    throw new Error("Missing complete V5 product copy: " + locale.code);
  }
  for (const [field, markers] of Object.entries(V5_PRODUCT_MARKERS)) {
    if (markers.some((marker) => !copy[field].includes(marker))) {
      throw new Error("Incomplete V5 product copy: " + locale.code + "." + field);
    }
  }
  if (locale.code !== "en" && V5_PRODUCT_FIELDS.every((field) => copy[field] === v5ProductCopy.en[field])) {
    throw new Error("V5 product copy falls back to English: " + locale.code);
  }
  locale.v5Product = Object.freeze({ ...copy });
}

if (locales.length !== CONNECTORS_LOCALES.length || new Set(locales.map(({ code }) => code)).size !== CONNECTORS_LOCALES.length || CONNECTORS_LOCALES.some((code) => !locales.some((locale) => locale.code === code))) {
  throw new Error("Locale catalog must match the independent Connectors iOS inventory");
}
const localeOrder = new Map(CONNECTORS_LOCALES.map((code, index) => [code, index]));
locales.sort((left, right) => localeOrder.get(left.code) - localeOrder.get(right.code));
export const publicRc1Locales = Object.freeze(PUBLIC_RC1_LOCALE_IDS.map((code) => {
  const locale = locales.find((entry) => entry.code === code);
  if (!locale) throw new Error(`RC1 public locale is absent from the source catalog: ${code}`);
  return locale;
}));

const v4Copy = overlayLocales({
  en: [
    "Evidence-first AI engineering QA and delivery gatekeeper.",
    "Let AI agents choose verification strength by risk and finish work safely in an isolated environment.",
    "Simple changes move fast; important work uses evidence gates; Git changes use a dedicated worktree by default.",
    "Check the repository, goal, scope, and source branch|Choose Auto fast path or evidence-required|Read-only work stays in place; Git changes create or reuse an isolated task worktree|Validate the result; integrate changes only when authorized|Clean only task-owned branches and worktrees",
    "Official recommendation: macOS + Codex — the deepest native integration and complete reference experience.",
    "Auto fast path still runs targeted checks and never bypasses protected branches|Protected or remote targets use governed PRs, fresh checks, and merge authority|Replay re-evaluates recorded evidence; it does not merge, push, or deploy again",
    "Better Workflows can block observable errors such as the wrong repository or revision, stale evidence, unauthorized side effects, and premature cleanup. It has not yet statistically proven lower long-term scope drift, rework, or decision-error rates."
  ],
  "zh-Hant-TW": [
    "證據至上的 AI 工程 QA＋交付守門人。",
    "讓 AI agent 依風險選擇驗證強度，在隔離環境安全完成工作。",
    "單純修改快速完成；重要工作使用證據 gate；Git 修改預設使用專屬 worktree。",
    "檢查程式碼儲存庫、Goal、scope 與原分支|判斷 Auto 快速路徑 或 evidence-required|唯讀工作留在原處；Git 修改才建立或重用隔離 task worktree|驗證結果；獲授權後才回併修改|只清理本任務擁有的 branch 與 worktree",
    "官方推薦：macOS + Codex——原生整合最深、參考體驗最完整。",
    "Auto 快速路徑 仍會執行 targeted check，且絕不繞過 protected branch|protected 或 remote target 必須走受治理 PR、fresh checks 與 merge authority|Replay 是重播已記錄證據的判斷，不會重新 merge、push 或 deploy",
    "Better Workflows 能阻擋錯誤的程式碼儲存庫、錯 revision、stale evidence、未授權副作用與過早 cleanup 等可觀測錯誤；但尚未以統計證明長期任務的整體 scope drift、rework 或錯誤決策率下降。"
  ]
}, "v4-copy", CONNECTORS_LOCALES);

for (const locale of locales) {
  const copy = v4Copy[locale.code];
  if (!copy || copy.length !== 7) throw new Error(`Missing v4 copy: ${locale.code}`);
  Object.assign(locale.messages, {
    TITLE: `Better Workflows | ${copy[0]}`,
    V4_POSITIONING: copy[0],
    V4_RISK_LEAD: copy[1],
    V4_SUMMARY: copy[2],
    V4_AUTO_FLOW: copy[3],
    V4_RECOMMENDED: copy[4],
    V4_BOUNDARIES: copy[5],
    V4_CLAIM_LIMIT: copy[6]
  });
}

const sponsorCopy = {
  "ar": ["ادعم باستخدام USDT (TRC20)", "ساعد Better Workflows على الاستمرار.", "يساعد الدعم لمرة واحدة في صيانة الشيفرة المفتوحة والوثائق والترجمة إلى 41 لغة واستضافة الموقع. ولا يمنح عضوية أو أولوية في خارطة الطريق أو الدعم."],
  "ca": ["Dona suport amb USDT (TRC20)", "Ajuda a mantenir Better Workflows.", "Una aportació puntual ajuda a mantenir el codi obert, la documentació, la localització en 41 idiomes i l’allotjament web. No compra cap membresia ni prioritat de full de ruta o suport."],
  "cs": ["Podpořit pomocí USDT (TRC20)", "Pomozte udržovat Better Workflows.", "Jednorázová podpora pomáhá udržovat open-source kód, dokumentaci, lokalizaci do 41 jazyků a provoz webu. Nezakládá členství ani prioritu v plánu či podpoře."],
  "da": ["Støt med USDT (TRC20)", "Hjælp med at holde Better Workflows i gang.", "Et engangsbidrag støtter vedligeholdelse af open source-kode, dokumentation, 41 sprog og webhosting. Det giver ikke medlemskab eller prioritet i roadmap eller support."],
  "de": ["Mit USDT (TRC20) unterstützen", "Hilf mit, Better Workflows nachhaltig zu pflegen.", "Eine einmalige Unterstützung hilft bei Open-Source-Code, Dokumentation, 41 Sprachversionen und Webhosting. Sie begründet keine Mitgliedschaft oder Priorität bei Roadmap und Support."],
  "el": ["Υποστήριξη με USDT (TRC20)", "Βοηθήστε να διατηρείται το Better Workflows.", "Μια εφάπαξ συνεισφορά στηρίζει τον ανοιχτό κώδικα, την τεκμηρίωση, τις 41 γλώσσες και τη φιλοξενία. Δεν αγοράζει συνδρομή ή προτεραιότητα σε roadmap και υποστήριξη."],
  "en": ["Support with USDT (TRC20)", "Help keep Better Workflows maintained.", "A one-time contribution supports open-source maintenance, documentation, 41 localized editions, and website hosting. It does not buy membership, roadmap priority, or support priority."],
  "es": ["Apoyar con USDT (TRC20)", "Ayuda a mantener Better Workflows.", "Una aportación única apoya el mantenimiento open source, la documentación, la localización en 41 idiomas y el alojamiento web. No compra membresía ni prioridad en el roadmap o el soporte."],
  "es-MX": ["Apoyar con USDT (TRC20)", "Ayuda a mantener Better Workflows.", "Un apoyo único ayuda a mantener el código abierto, la documentación, la localización en 41 idiomas y el sitio web. No compra membresía ni prioridad en el roadmap o soporte."],
  "fi": ["Tue USDT:llä (TRC20)", "Auta pitämään Better Workflows ylläpidettynä.", "Kertaluonteinen tuki auttaa avoimen lähdekoodin, dokumentaation, 41 kielen lokalisoinnin ja verkkosivun ylläpidossa. Se ei anna jäsenyyttä eikä etusijaa kehityksessä tai tuessa."],
  "fil": ["Sumuporta gamit ang USDT (TRC20)", "Tulungang mapanatili ang Better Workflows.", "Ang minsanang suporta ay tumutulong sa open-source maintenance, dokumentasyon, 41-wikang localization, at website hosting. Hindi ito kapalit ng membership o priority sa roadmap o support."],
  "fr": ["Soutenir avec USDT (TRC20)", "Aidez à maintenir Better Workflows.", "Un soutien ponctuel finance la maintenance open source, la documentation, la localisation en 41 langues et l’hébergement du site. Il n’achète ni adhésion ni priorité de roadmap ou de support."],
  "he": ["תמיכה באמצעות USDT (TRC20)", "עזרו לשמור על Better Workflows מתוחזק.", "תמיכה חד-פעמית מסייעת בתחזוקת הקוד הפתוח, התיעוד, הלוקליזציה ל-41 שפות ואחסון האתר. היא אינה מקנה חברות או קדימות במפת הדרכים או בתמיכה."],
  "hi": ["USDT (TRC20) से सहयोग करें", "Better Workflows के रखरखाव में मदद करें।", "एक बार का सहयोग मुक्त-स्रोत रखरखाव, दस्तावेज़, 41 भाषाओं के localization और वेबसाइट hosting में मदद करता है। इससे membership, roadmap या support priority नहीं मिलती।"],
  "hr": ["Podrži uz USDT (TRC20)", "Pomozite održavati Better Workflows.", "Jednokratna podrška pomaže održavanju otvorenog koda, dokumentacije, lokalizacije na 41 jezik i web-hostinga. Ne donosi članstvo ni prioritet za plan razvoja ili podršku."],
  "hu": ["Támogatás USDT-vel (TRC20)", "Segíts a Better Workflows fenntartásában.", "Az egyszeri támogatás a nyílt forráskód, a dokumentáció, a 41 nyelvű lokalizáció és a webtárhely fenntartását segíti. Nem jár tagsággal, ütemtervi vagy támogatási elsőbbséggel."],
  "id": ["Dukung dengan USDT (TRC20)", "Bantu menjaga Better Workflows tetap terawat.", "Dukungan satu kali membantu pemeliharaan open source, dokumentasi, lokalisasi 41 bahasa, dan hosting situs. Dukungan tidak membeli keanggotaan atau prioritas roadmap maupun bantuan."],
  "it": ["Sostieni con USDT (TRC20)", "Aiuta a mantenere Better Workflows.", "Un contributo una tantum sostiene manutenzione open source, documentazione, localizzazione in 41 lingue e hosting del sito. Non acquista iscrizioni né priorità di roadmap o assistenza."],
  "ja": ["USDT（TRC20）で支援", "Better Workflows の継続的なメンテナンスを支えてください。", "一度限りの支援は、オープンソースの保守、ドキュメント、41 ロケール向けのローカライズ版、Web サイト運営に役立ちます。会員資格、roadmap、サポートの優先権を購入するものではありません。"],
  "km": ["គាំទ្រដោយ USDT (TRC20)", "ជួយរក្សា Better Workflows ឱ្យបន្តថែទាំ។", "ការគាំទ្រម្តងជួយថែទាំកូដប្រភពបើកចំហ ឯកសារ ការបកប្រែ 41 ភាសា និងការបង្ហោះគេហទំព័រ។ វាមិនផ្តល់សមាជិកភាព ឬអាទិភាព roadmap និង support ទេ។"],
  "ko": ["USDT (TRC20)로 후원", "Better Workflows의 꾸준한 유지 관리를 도와주세요.", "일회성 후원은 오픈 소스 유지 관리, 문서, 41개 로캘용 현지화 버전과 웹사이트 운영에 사용됩니다. 멤버십이나 roadmap 및 지원 우선권을 구매하는 것은 아닙니다."],
  "lo": ["ສະໜັບສະໜູນດ້ວຍ USDT (TRC20)", "ຊ່ວຍໃຫ້ Better Workflows ໄດ້ຮັບການດູແລຕໍ່ໄປ.", "ການສະໜັບສະໜູນຄັ້ງດຽວຊ່ວຍບຳລຸງ ຊອບແວແຫຼ່ງເປີດ, ເອກະສານ, ການແປ 41 ພາສາ ແລະ hosting. ບໍ່ໄດ້ຮັບສະມາຊິກ ຫຼືສິດກ່ອນໃນ roadmap/support."],
  "ms": ["Sokong dengan USDT (TRC20)", "Bantu kekalkan Better Workflows.", "Sokongan sekali membantu penyelenggaraan sumber terbuka, dokumentasi, penyetempatan 41 bahasa dan pengehosan laman. Ia tidak membeli keahlian atau keutamaan roadmap dan sokongan."],
  "my": ["USDT (TRC20) ဖြင့် ပံ့ပိုးပါ", "Better Workflows ကို ဆက်လက်ထိန်းသိမ်းနိုင်ရန် ကူညီပါ။", "တစ်ကြိမ်တည်း ပံ့ပိုးမှုသည် open-source ထိန်းသိမ်းမှု၊ စာရွက်စာတမ်း၊ ဘာသာစကား ၄၁ မျိုးနှင့် website hosting ကို ကူညီသည်။ membership သို့မဟုတ် roadmap/support ဦးစားပေးမှု မရပါ။"],
  "nb": ["Støtt med USDT (TRC20)", "Hjelp oss å vedlikeholde Better Workflows.", "Et engangsbidrag støtter vedlikehold av åpen kildekode, dokumentasjon, 41 språk og webhosting. Det gir ikke medlemskap eller prioritet i veikart eller brukerstøtte."],
  "nl": ["Steun met USDT (TRC20)", "Help Better Workflows onderhouden.", "Een eenmalige bijdrage ondersteunt open-sourceonderhoud, documentatie, lokalisatie in 41 talen en websitehosting. Ze geeft geen lidmaatschap of voorrang op de roadmap of ondersteuning."],
  "pl": ["Wesprzyj za pomocą USDT (TRC20)", "Pomóż utrzymywać Better Workflows.", "Jednorazowe wsparcie pomaga utrzymywać otwarty kod, dokumentację, lokalizację na 41 języków i hosting strony. Nie zapewnia członkostwa ani priorytetu w planie lub pomocy technicznej."],
  "pt": ["Apoiar com USDT (TRC20)", "Ajude a manter o Better Workflows.", "Um apoio pontual contribui para o código aberto, documentação, localização em 41 idiomas e alojamento do site. Não compra filiação nem prioridade no roadmap ou suporte."],
  "pt-BR": ["Apoiar com USDT (TRC20)", "Ajude a manter o Better Workflows.", "Um apoio único contribui para manutenção open source, documentação, localização em 41 idiomas e hospedagem do site. Não compra associação nem prioridade no roadmap ou suporte."],
  "ro": ["Susține cu USDT (TRC20)", "Ajută la întreținerea Better Workflows.", "O contribuție unică susține codul open source, documentația, localizarea în 41 de limbi și găzduirea site-ului. Nu oferă abonament sau prioritate pentru roadmap ori suport."],
  "ru": ["Поддержать с помощью USDT (TRC20)", "Помогите поддерживать Better Workflows.", "Разовая поддержка помогает развивать открытый код, документацию, локализацию на 41 язык и хостинг сайта. Она не дает членство или приоритет в roadmap и поддержке."],
  "sk": ["Podporiť pomocou USDT (TRC20)", "Pomôžte udržiavať Better Workflows.", "Jednorazová podpora pomáha udržiavať otvorený kód, dokumentáciu, lokalizáciu do 41 jazykov a webhosting. Neprináša členstvo ani prioritu v pláne či podpore."],
  "sv": ["Stöd med USDT (TRC20)", "Hjälp till att underhålla Better Workflows.", "Ett engångsbidrag stöder underhåll av öppen källkod, dokumentation, 41 språk och webbhosting. Det ger inget medlemskap eller prioritet i roadmap eller support."],
  "th": ["สนับสนุนด้วย USDT (TRC20)", "ช่วยให้ Better Workflows ได้รับการดูแลต่อเนื่อง", "การสนับสนุนครั้งเดียวช่วยดูแลโอเพนซอร์ส เอกสาร การแปล 41 ภาษา และเว็บโฮสติ้ง โดยไม่ให้สมาชิกหรือสิทธิ์ลำดับความสำคัญใน roadmap และ support"],
  "tr": ["USDT (TRC20) ile destekle", "Better Workflows’un bakımına yardımcı olun.", "Tek seferlik destek; açık kaynak bakımı, belgeler, 41 dilde yerelleştirme ve site barındırmasına katkı sağlar. Üyelik ya da roadmap ve destek önceliği satın almaz."],
  "uk": ["Підтримати за допомогою USDT (TRC20)", "Допоможіть підтримувати Better Workflows.", "Одноразова підтримка допомагає відкритому коду, документації, локалізації 41 мовою та хостингу сайту. Вона не надає членства чи пріоритету в roadmap або підтримці."],
  "vi": ["Ủng hộ bằng USDT (TRC20)", "Hãy giúp duy trì Better Workflows.", "Khoản ủng hộ một lần hỗ trợ bảo trì mã nguồn mở, tài liệu, bản địa hóa 41 ngôn ngữ và lưu trữ website. Khoản này không mua tư cách thành viên hay ưu tiên roadmap hoặc hỗ trợ."],
  "zh-Hans": ["通过 USDT（TRC20）单次赞助", "帮助 Better Workflows 持续维护。", "单次赞助将用于开源维护、文档、41 个本地化版本与网站托管；不包含会员资格，也不提供产品路线图或技术支持优先权。"],
  "zh-Hant": ["透過 USDT（TRC20）單次贊助", "協助 Better Workflows 持續維護。", "單次贊助將用於開源維護、文件、41 個本地化版本與網站託管；不包含會員資格，也不提供產品路線圖或技術支援優先權。"],
  "zh-Hant-HK": ["透過 USDT（TRC20）一次過贊助", "協助 Better Workflows 持續維護。", "一次過贊助會用於開源維護、文件、41 個本地化版本同網站託管；唔包括會員資格，亦唔會提供產品路線圖或技術支援優先權。"],
  "zh-Hant-TW": ["透過 USDT（TRC20）單次贊助", "一起支持 Better Workflows 持續維護。", "單次贊助將用於開源維護、文件、41 個在地化版本與網站託管；不包含會員資格，也不提供產品路線圖或技術支援優先權。"]
};

export const SPONSOR_ONE_TIME_MARKERS = {
  "ar": "لمرة واحدة",
  "ca": "puntual",
  "cs": "Jednorázová",
  "da": "engangsbidrag",
  "de": "einmalige",
  "el": "εφάπαξ",
  "en": "one-time",
  "es": "única",
  "es-MX": "único",
  "fi": "Kertaluonteinen",
  "fil": "minsanan",
  "fr": "ponctuel",
  "he": "חד-פעמית",
  "hi": "एक बार",
  "hr": "Jednokratna",
  "hu": "egyszeri",
  "id": "satu kali",
  "it": "una tantum",
  "ja": "一度限り",
  "km": "ម្តង",
  "ko": "일회성",
  "lo": "ຄັ້ງດຽວ",
  "ms": "sekali",
  "my": "တစ်ကြိမ်တည်း",
  "nb": "engangsbidrag",
  "nl": "eenmalige",
  "pl": "Jednorazowe",
  "pt": "pontual",
  "pt-BR": "único",
  "ro": "unică",
  "ru": "Разовая",
  "sk": "Jednorazová",
  "sv": "engångsbidrag",
  "th": "ครั้งเดียว",
  "tr": "Tek seferlik",
  "uk": "Одноразова",
  "vi": "một lần",
  "zh-Hans": "单次赞助",
  "zh-Hant": "單次贊助",
  "zh-Hant-HK": "一次過贊助",
  "zh-Hant-TW": "單次贊助"
};

export const SPONSOR_LOCALE_MARKERS = {
  "ar": "الترجمة إلى 41 لغة",
  "ca": "localització en 41 idiomes",
  "cs": "lokalizaci do 41 jazyků",
  "da": "41 sprog",
  "de": "41 Sprachversionen",
  "el": "τις 41 γλώσσες",
  "en": "41 localized editions",
  "es": "localización en 41 idiomas",
  "es-MX": "localización en 41 idiomas",
  "fi": "41 kielen lokalisoinnin",
  "fil": "41-wikang localization",
  "fr": "localisation en 41 langues",
  "he": "הלוקליזציה ל-41 שפות",
  "hi": "41 भाषाओं के localization",
  "hr": "lokalizacije na 41 jezik",
  "hu": "41 nyelvű lokalizáció",
  "id": "lokalisasi 41 bahasa",
  "it": "localizzazione in 41 lingue",
  "ja": "41 ロケール向けのローカライズ版",
  "km": "ការបកប្រែ 41 ភាសា",
  "ko": "41개 로캘용 현지화 버전",
  "lo": "ການແປ 41 ພາສາ",
  "ms": "penyetempatan 41 bahasa",
  "my": "ဘာသာစကား ၄၁ မျိုး",
  "nb": "41 språk",
  "nl": "lokalisatie in 41 talen",
  "pl": "lokalizację na 41 języków",
  "pt": "localização em 41 idiomas",
  "pt-BR": "localização em 41 idiomas",
  "ro": "localizarea în 41 de limbi",
  "ru": "локализацию на 41 язык",
  "sk": "lokalizáciu do 41 jazykov",
  "sv": "41 språk",
  "th": "การแปล 41 ภาษา",
  "tr": "41 dilde yerelleştirme",
  "uk": "локалізації 41 мовою",
  "vi": "bản địa hóa 41 ngôn ngữ",
  "zh-Hans": "41 个本地化版本",
  "zh-Hant": "41 個本地化版本",
  "zh-Hant-HK": "41 個本地化版本",
  "zh-Hant-TW": "41 個在地化版本"
};

for (const locale of locales) {
  const copy = sponsorCopy[locale.code];
  if (!copy) throw new Error(`Missing sponsor copy: ${locale.code}`);
  if (!copy[2].includes(SPONSOR_ONE_TIME_MARKERS[locale.code])) throw new Error(`Sponsor copy is not explicitly one-time: ${locale.code}`);
  if (!copy[2].includes(SPONSOR_LOCALE_MARKERS[locale.code])) throw new Error(`Sponsor copy does not describe its locale scope: ${locale.code}`);
  Object.assign(locale.messages, { SPONSOR_CTA: copy[0], SPONSOR_TITLE: copy[1], SPONSOR_BODY: copy[2] });
}
