<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Riktlinjer för README\-kvalitet

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · **Svenska** · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Översikt i 41 lokaliserade utgåvor och officiella ingångar på webben](../../../docs/LANGUAGES.md)\. Den engelska versionen av dessa redaktionella riktlinjer förblir den kanoniska källan\.

En README för Better Workflows är en landningssida\, inte en komprimerad referenshandbok\. Dess uppgift är att hjälpa läsaren att besvara fem frågor i följd\:

1. Vad är detta\, och passar det mig\?
2. Vilket problem löser det\?
3. Varför ska jag lita på dess påståenden\?
4. Vilken är den kortaste vägen till ett första lyckat resultat\?
5. Vart ska jag gå härnäst\?

Dessa riktlinjer definierar kontraktet för berättelse\, visuellt innehåll\, lokalisering och validering för varje README i kodarkivet\. Den maskinläsbara källan är [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Utgå från läsarens beslut

GitHub visar en README före det mesta av kodarkivets övriga innehåll\. Den första skärmbilden måste därför klargöra produktens löfte\, målgruppen och en avgränsad nästa åtgärd\. Den får inte börja med intern arkitektur\, en fullständig kommandoreferens eller detaljer om återställning av utgåvor\.

Skriv för följande läsaruppgifter\:

- **Ny besökare\:** avgör snabbt om Better Workflows löser ett relevant problem\.
- **Ny användare\:** installera insticksmodulen och nå en lyckad automatisk rutt\.
- **Utvärderare\:** förstå auktoritetsgränsen och fail\-closed\-beteendet\.
- **Återkommande operatör\:** gå direkt till ett svar om arbetsflöde\, säkerhet\, arkitektur eller CLI\.
- **Bidragsgivare eller översättare\:** hitta det kanoniska kontraktet\, utvecklingskommandon\, support och styrning\.

## Använd en berättelse om orsak och verkan

De fem README\-landningssidorna använder samma semantiska följd i åtta delar\. Rubrikerna får vara idiomatiska på respektive språk\, men läsarens väg förändras inte\.

| Avsnitt | Läsarfråga och roll i berättelsen |
| --- | --- |
| Löfte och målgrupp | Vad är Better Workflows\, varför finns det och vem är det till för\? |
| Från problem till resultat | Vad går fel när avsikt\, befogenheter\, bevis och leverantörens utfall blandas ihop\? |
| Belägg och gränser | Vilka garantier gör det föreslagna resultatet trovärdigt\? |
| Första lyckade resultatet | Vilken är den kortaste fullständiga vägen från installation till resultat\? |
| Välj nästa väg | Vilket arbetsflöde eller dokument motsvarar läsarens mål\? |
| Livscykel | Hur blir ett mål ett avstämt slutförande – eller stoppas på ett säkert sätt\? |
| Tillit och begränsningar | Vad får systemet aldrig dra slutsatser om\, auktorisera eller påstå\? |
| Lär dig\, få hjälp\, bidra | Var finns den fördjupade dokumentationen\, support\, styrning\, utveckling och licens\? |

Denna ordning ger en praktisk berättelsekurva\:

- **Sammanhang\:** promptstyrt arbete kan uttrycka avsikt utan att bevisa befogenheter eller tillstånd\.
- **Spänning\:** sidoeffekter gör denna lucka till en leveransrisk\.
- **Lösning\:** Better Workflows knyter samman mål\, omfattning\, bevis\, granskning\, åtgärd och avstämning mot leverantörens resultat\.
- **Belägg\:** uttryckliga garantier och gränser visar hur lösningen fungerar\.
- **Handling\:** läsaren når ett första lyckat resultat innan hen möter djupgående implementationsdetaljer\.
- **Fortsättning\:** roll\- och resultatbaserade vägar leder läsaren till rätt introduktion\, praktiska vägledning\, förklaring eller referens\.

## Skilj landningsinnehåll från fördjupad dokumentation

Använd README för information som är relevant för beslutet\. Hänvisa till fördjupning utifrån syfte\:

- [Kom igång](getting-started.md) är introduktionen för första användningen\.
- [Arbetsflöden](workflows.md) är den praktiska vägledningen för att välja resultat\.
- [Arkitektur](architecture.md) förklarar styrplanet och avvägningarna\.
- [Säkerhet](security-guide.md) förklarar befogenheter\, integritet\, intyg och beteendet som blockerar när verifiering saknas\.
- [CLI\-referens](cli-reference.md) är kommandoreferensen\.
- Lokaliserade sidor i `docs/details/*.md` bevarar fullständiga översatta detaljer\.

Duplicera inte cacheåterställning\, ägarskap för lås\, fullständig semantik för leverantörstransport\, uttömmande kommandolistor eller historik över implementationsändringar på landningssidan\. Ett kortfattat säkerhetspåstående stannar på sidan\; dess granskningsbara fördjupning hör hemma i den kanoniska guiden\.

Denna uppdelning följer Diátaxis åtskillnad mellan introduktioner\, praktiska vägledningar\, förklaringar och referenser\. En enda sida kan inte optimeras för alla fyra läsarbehoven samtidigt\.

## Låt varje visualisering motivera sin plats

Använd en visualisering endast när relationer\, hierarki eller tillståndsövergångar blir väsentligt lättare att förstå än med löptext\.

Landningssidorna tillåter två visualiseringar\:

1. **Arkitektur för behörighetsgränser\:** besvarar vilka lager som formar avsikt\, aktuella fakta\, verktygsbefogenheter\, begränsade omförsök och skrivskyddat tillstånd\.
2. **Livscykel från mål till slutförande\:** besvarar var bevis kontrolleras\, var sidoeffekter auktoriseras och var okänt tillstånd stoppar framsteg\.

Varje visualisering måste innehålla\:

- kortfattad\, meningsfull alternativtext\;
- en intilliggande textmotsvarighet som bevarar slutsatsen när visualiseringen är dold eller Mermaid inte renderas\;
- verklig text för väsentliga etiketter när det är möjligt\;
- en stabil läsarfråga som motiverar att visualiseringen hålls aktuell\.

Lägg inte till dekorativa skärmbilder\, texttunga bilder eller diagram som enbart duplicerar en kort lista\. Begränsa urvalstabeller till två kortfattade kolumner så att de förblir användbara på smala skärmar\.

## Bevara innebörden mellan språk

Engelska är den semantiska referensen\, inte ett mål för antal rader\. Traditionell kinesiska\, förenklad kinesiska\, japanska och koreanska ska låta naturliga för modersmålstalare och samtidigt bevara samma kontrakt\.

Följande måste förbli likvärdigt\:

- de åtta semantiska avsnitten och deras ordning\;
- kommandon för ett första lyckat resultat och produktidentifierare\;
- de fem påståendena om befogenheter\, bevis\, okänt tillstånd\, prompter och integritet\;
- målsidor för arbetsflöden\, säkerhet\, arkitektur\, CLI\, support\, styrning\, utveckling och licens\;
- visualiseringarnas syfte\, livscykelsteg och textalternativ\;
- versionskälla och policy för statusmärken\.

Rubriker\, meningsgränser\, skiljetecken\, exempel och uppmaningar får vara idiomatiska\. Översätt aldrig kommandon\, väljare\, bevisidentifierare eller säkerhetssemantik\.

## Skriv för överblick och översättning

- Börja med läsarens resultat och placera viktiga begrepp i början av rubriker och stycken\.
- Använd aktiv form och ange vem som ansvarar för en åtgärd\.
- Tilltala läsaren direkt i instruktioner\.
- Håll styckena korta och ge varje stycke en enda uppgift\.
- Använd numrerade listor för följder och punktlistor för val utan inbördes ordning\.
- Använd beskrivande länkar i stället för allmänna etiketter som ”klicka här”\.
- Håll rubriker hierarkiska\, specifika och parallellt utformade på samma nivå\.
- Föredra bokstavligt\, entydigt språk som fungerar vid översättning\.
- Placera villkor före instruktioner och förväntade resultat efter kommandon\.

## Validera semantik\, inte utsmyckning

Dokumentationstesterna måste upptäcka mer än matchande rubriker\. De verifierar\:

- en H1 och en logisk rubrikhierarki\;
- ordnade semantiska avsnitts\- och kritiska påståendemarkörer\;
- exakta kommandon för första lyckade körning och stabila identifierare\;
- relativa länkar och språkspecifika målsidor för detaljer\;
- paritet mellan versionsmärke och metadata för körtid\;
- meningsfull alt\-text för bilder och intilliggande visuella reservalternativ\;
- en enda Mermaid\-livscykel med en fullständig motsvarighet i text\;
- budget för tvåkolumnstabeller och styckelängd\;
- avsaknad av angivna djupa implementeringsdetaljer på landningssidor\;

## Forskningsunderlag

- [GitHub\: Om kodarkivets README\-fil](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) definierar syftet med README vid första besöket och rekommenderar att längre dokumentation flyttas till andra platser\.
- [Diátaxis](https://diataxis.fr/start-here/) skiljer mellan behov av introduktioner\, praktiska vägledningar\, förklaringar och referenser\.
- [Microsoft\: Innehåll som är lätt att överblicka](https://learn.microsoft.com/en-us/style-guide/scannable-content/) betonar en struktur med det viktigaste först\, korta stycken och konsekventa visuella ingångar\.
- [Googles stilguide för utvecklardokumentation](https://developers.google.com/style/highlights) rekommenderar aktiv form\, direkt tilltal\, beskrivande rubriker\, tillgänglighet och skrivande för en global publik\.
- [GitHub\: Skapa diagram](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) dokumenterar stödet för Mermaid i Markdown\.
- [W3C WAI\: Introduktion till bilder](https://www.w3.org/WAI/tutorials/images/) kräver textalternativ och fullständiga motsvarigheter till informativa och komplexa visualiseringar\.
