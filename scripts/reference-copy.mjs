import { CONNECTORS_LOCALES } from "./website-locales.mjs";

// Keep the RC1 overview link label shared by generated guides and locale tests.
// It identifies the two planned public routes without implying full-body review.
export const LOCALE_OVERVIEW_LABELS = Object.freeze({
  "zh-Hant": "41 個語系版本的在地化總覽與官網入口",
  "zh-Hant-TW": "41 個語系版本的在地化總覽與官網入口",
  "zh-Hant-HK": "41 個語系版本的本地化總覽與官方網站入口",
  "zh-Hans": "41 个本地化版本的概览与官网入口",
  "vi": "Tổng quan với 41 bản địa hóa và các điểm truy cập web chính thức",
  "uk": "Огляд у 41 локалізованій версії та офіційні точки входу на вебсайтах",
  "tr": "41 yerelleştirilmiş sürümde genel bakış ve resmî web giriş noktaları",
  "th": "ภาพรวมที่ปรับให้เหมาะกับท้องถิ่น 41 ฉบับและช่องทางเข้าสู่เว็บไซต์อย่างเป็นทางการ",
  "sv": "Översikt i 41 lokaliserade utgåvor och officiella ingångar på webben",
  "sk": "Prehľad v 41 lokalizovaných vydaniach a oficiálne webové vstupné body",
  "ru": "Обзор в 41 локализованной версии и официальные точки входа на сайте",
  "ro": "Prezentare generală în 41 de versiuni localizate și puncte oficiale de acces web",
  "pt": "Visão geral em 41 versões localizadas e pontos de acesso oficiais na Web",
  "pt-BR": "Visão geral em 41 versões localizadas e pontos de acesso oficiais na Web",
  "pl": "Przegląd w 41 wersjach lokalizowanych i oficjalne punkty dostępu w sieci",
  "nl": "Overzicht in 41 gelokaliseerde versies en officiële toegangspunten op het web",
  "nb": "Oversikt i 41 lokaliserte utgaver og offisielle innganger på nettet",
  "my": "ဒေသသုံးဘာသာပြန်မူ 41 မူပါ ခြုံငုံသုံးသပ်ချက်နှင့် တရားဝင်ဝက်ဘ်ဝင်ပေါက်များ",
  "ms": "Gambaran keseluruhan dalam 41 versi setempat dan pintu masuk web rasmi",
  "lo": "ພາບລວມໃນ 41 ສະບັບປັບເຂົ້າທ້ອງຖິ່ນ ແລະ ຊ່ອງທາງເຂົ້າເວັບທາງການ",
  "ko": "41개 로캘 버전의 현지화 개요와 공식 웹 진입점",
  "km": "ទិដ្ឋភាពទូទៅក្នុងកំណែដែលបានសម្របតាមភាសា និងតំបន់ចំនួន 41 និងច្រកចូលគេហទំព័រផ្លូវការ",
  "ja": "41 ロケール版の概要と公式ウェブのアクセス先",
  "it": "Panoramica in 41 versioni localizzate e punti di accesso web ufficiali",
  "id": "Ikhtisar dalam 41 edisi yang dilokalkan dan titik akses web resmi",
  "hu": "Áttekintés 41 lokalizált változatban és hivatalos webes belépési pontok",
  "hr": "Pregled u 41 lokaliziranoj verziji i službene pristupne točke na webu",
  "hi": "41 स्थानीयकृत संस्करणों का अवलोकन और आधिकारिक वेब प्रवेश बिंदु",
  "he": "סקירה ב־41 גרסאות מותאמות לשפה ולאזור ונקודות גישה רשמיות באתר",
  "fr": "Vue d’ensemble en 41 éditions localisées et points d’accès web officiels",
  "fil": "Pangkalahatang-ideya sa 41 lokal na bersyon at mga opisyal na pasukan sa web",
  "fi": "Yleiskatsaus 41 lokalisoituna versiona ja viralliset verkkosivujen aloituskohdat",
  "es": "Resumen en 41 versiones localizadas y puntos de acceso web oficiales",
  "es-MX": "Resumen en 41 versiones localizadas y puntos de acceso web oficiales",
  "el": "Επισκόπηση σε 41 τοπικοποιημένες εκδόσεις και επίσημα σημεία πρόσβασης στον ιστό",
  "de": "Überblick in 41 Sprach- und Regionalversionen und offizielle Web-Einstiegspunkte",
  "da": "Oversigt i 41 lokaliserede udgaver og officielle indgange på nettet",
  "cs": "Přehled ve 41 lokalizovaných verzích a oficiální webové vstupní body",
  "ca": "Resum en 41 versions localitzades i punts d’accés web oficials",
  "ar": "نظرة عامة في 41 نسخة موطّنة ونقاط الوصول الرسمية على الويب"
});

// State the actual reference-body coverage in the reader's language.
export const REFERENCE_CONTENT_NOTICES = Object.freeze({
  "en": "This reference page has a localized overview; its interactive content is not fully translated across all locales.",
  "zh-Hant": "此參考頁已提供本語系摘要；互動內容尚未完整翻譯。",
  "zh-Hant-TW": "此參考頁已提供本語系摘要；互動內容尚未完整翻譯。",
  "zh-Hant-HK": "此參考頁已提供本地化摘要；互動內容尚未完整翻譯。",
  "zh-Hans": "此参考页已提供本地化摘要；交互内容尚未完整翻译。",
  "vi": "Trang tham khảo này đã có phần tổng quan bằng ngôn ngữ của bạn; nội dung tương tác chưa được dịch đầy đủ.",
  "uk": "Ця довідкова сторінка має локалізований огляд; її інтерактивний вміст ще не перекладено повністю.",
  "tr": "Bu başvuru sayfasının özeti yerelleştirilmiştir; etkileşimli içeriğin çevirisi henüz tamamlanmamıştır.",
  "th": "หน้าข้อมูลอ้างอิงนี้มีภาพรวมที่แปลแล้ว แต่เนื้อหาแบบโต้ตอบยังแปลไม่ครบ",
  "sv": "Den här referenssidan har en lokaliserad översikt; det interaktiva innehållet är ännu inte helt översatt.",
  "sk": "Táto referenčná stránka má lokalizovaný prehľad; jej interaktívny obsah ešte nie je úplne preložený.",
  "ru": "На этой справочной странице переведён обзор; интерактивное содержимое пока переведено не полностью.",
  "ro": "Această pagină de referință are o prezentare generală localizată; conținutul interactiv nu este încă tradus integral.",
  "pt": "Esta página de referência tem uma visão geral localizada; o conteúdo interativo ainda não está totalmente traduzido.",
  "pt-BR": "Esta página de referência tem uma visão geral localizada; o conteúdo interativo ainda não está totalmente traduzido.",
  "pl": "Ta strona referencyjna ma przetłumaczony przegląd; jej interaktywna treść nie została jeszcze w całości przetłumaczona.",
  "nl": "Deze referentiepagina heeft een gelokaliseerd overzicht; de interactieve inhoud is nog niet volledig vertaald.",
  "nb": "Denne referansesiden har en lokalisert oversikt; det interaktive innholdet er ennå ikke fullstendig oversatt.",
  "my": "ဤကိုးကားစာမျက်နှာတွင် မိမိဘာသာစကားဖြင့် အကျဉ်းချုပ် ရရှိနိုင်သော်လည်း အပြန်အလှန်တုံ့ပြန်နိုင်သော အကြောင်းအရာကို အပြည့်အစုံ မပြန်ဆိုရသေးပါ။",
  "ms": "Halaman rujukan ini mempunyai gambaran keseluruhan yang telah disetempatkan; kandungan interaktifnya belum diterjemahkan sepenuhnya.",
  "lo": "ໜ້າອ້າງອີງນີ້ມີພາບລວມທີ່ແປແລ້ວ; ເນື້ອຫາແບບໂຕ້ຕອບຍັງແປບໍ່ຄົບຖ້ວນ.",
  "ko": "이 참고 페이지의 개요는 현지화되어 있지만, 대화형 콘텐츠는 아직 모두 번역되지 않았습니다.",
  "km": "ទំព័រឯកសារយោងនេះមានសេចក្ដីសង្ខេបដែលបានបកប្រែហើយ ប៉ុន្តែខ្លឹមសារអន្តរកម្មមិនទាន់ត្រូវបានបកប្រែពេញលេញទេ។",
  "ja": "この参照ページの概要は翻訳済みですが、インタラクティブな本文はまだすべて翻訳されていません。",
  "it": "Questa pagina di riferimento ha una panoramica localizzata; il contenuto interattivo non è ancora interamente tradotto.",
  "id": "Halaman referensi ini memiliki ikhtisar yang telah dilokalkan; konten interaktifnya belum sepenuhnya diterjemahkan.",
  "hu": "Ezen a referenciaoldalon az áttekintés lokalizált; az interaktív tartalom fordítása még nem teljes.",
  "hr": "Ova referentna stranica ima lokalizirani pregled; interaktivni sadržaj još nije u cijelosti preveden.",
  "hi": "इस संदर्भ पृष्ठ का अवलोकन स्थानीयकृत है; इसकी संवादात्मक सामग्री का अभी पूरा अनुवाद नहीं हुआ है।",
  "he": "בדף העזר הזה יש סקירה מתורגמת; התוכן האינטראקטיבי עדיין לא תורגם במלואו.",
  "fr": "Cette page de référence propose un aperçu traduit ; son contenu interactif n’est pas encore entièrement traduit.",
  "fil": "May isinaling pangkalahatang-ideya ang pahinang ito ng sanggunian; hindi pa ganap na naisalin ang interaktibong nilalaman.",
  "fi": "Tämän viitesivun yleiskatsaus on lokalisoitu; vuorovaikutteista sisältöä ei ole vielä käännetty kokonaan.",
  "es": "Esta página de referencia tiene un resumen localizado; el contenido interactivo aún no está traducido por completo.",
  "es-MX": "Esta página de referencia tiene un resumen localizado; el contenido interactivo todavía no está traducido por completo.",
  "el": "Αυτή η σελίδα αναφοράς διαθέτει μεταφρασμένη επισκόπηση· το διαδραστικό περιεχόμενο δεν έχει ακόμη μεταφραστεί πλήρως.",
  "de": "Diese Referenzseite enthält einen lokalisierten Überblick; die interaktiven Inhalte sind noch nicht vollständig übersetzt.",
  "da": "Denne referenceside har en lokaliseret oversigt; det interaktive indhold er endnu ikke fuldt oversat.",
  "cs": "Tato referenční stránka má lokalizovaný přehled; interaktivní obsah zatím není přeložen úplně.",
  "ca": "Aquesta pàgina de referència té un resum localitzat; el contingut interactiu encara no està traduït del tot.",
  "ar": "تتضمن صفحة المرجع هذه نظرة عامة مترجمة، لكن محتواها التفاعلي لم يُترجم بالكامل بعد."
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
