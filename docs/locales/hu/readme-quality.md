<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# A README minőségi terve

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · **Magyar** · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Áttekintés 41 lokalizált változatban és hivatalos webes belépési pontok](../../../docs/LANGUAGES.md)\. E szerkesztési terv angol változata marad a kanonikus forrás\.

A Better Workflows README egy nyitóoldal\, nem pedig tömörített referencia\-kézikönyv\. Feladata\, hogy segítsen az olvasónak sorban megválaszolni öt kérdést\:

1. Mi ez\, és nekem való\-e\?
2. Milyen problémát old meg\?
3. Miért bízzak az állításaiban\?
4. Mi a legrövidebb út az első sikerhez\?
5. Merre menjek tovább\?

Ez a terv meghatározza a tároló minden README\-fájljának narratív\, vizuális\, lokalizációs és validációs szerződését\. A géppel olvasható forrás\: [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Az olvasó döntéséből indulj ki

A GitHub a tároló legtöbb tartalma előtt mutatja meg a README\-fájlt\. Az első képernyőnek ezért világossá kell tennie a termék ígéretét\, célközönségét és egy behatárolt következő lépést\. Nem kezdődhet belső architektúrával\, teljes parancsreferenciával vagy a kiadások helyreállításának részleteivel\.

Ezekhez az olvasói feladatokhoz írj\:

- **Új látogató\:** gyorsan döntse el\, hogy a Better Workflows megoldja\-e a felmerülő problémáját\.
- **Új felhasználó\:** telepítse a beépülő modult\, és érjen el egy sikeres automatikus útvonalat\.
- **Értékelő\:** értse meg a jogosultsági határokat és a fail\-closed működést\.
- **Visszatérő operátor\:** ugorjon egy munkafolyamatra\, biztonságra\, architektúrára vagy CLI\-re vonatkozó válaszra\.
- **Közreműködő vagy fordító\:** találja meg a kanonikus szerződést\, a fejlesztői parancsokat\, a támogatást és az irányítást\.

## Használj ok\-okozati elbeszélést

Az öt nyitóoldali README ugyanazt a nyolcrészes szemantikai sorrendet használja\. A címsorok nyelvenként természetesen fogalmazhatók meg\, de az olvasó útja nem változik\.

| Szakasz | Az olvasó kérdése és a narratív szerep |
| --- | --- |
| Ígéret és közönség | Mi a Better Workflows\, miért létezik\, és kinek szól\? |
| A problémától az eredményig | Mi romlik el\, ha összemossák a szándékot\, a felhatalmazást\, a bizonyítékokat és a szolgáltatói eredményt\? |
| Bizonyítás és határok | Mely garanciák teszik hitelessé a javasolt eredményt\? |
| Első siker | Mi a legrövidebb teljes út a telepítéstől az eredményig\? |
| A következő út kiválasztása | Melyik munkafolyamat vagy dokumentum illik az olvasó céljához\? |
| Életciklus | Hogyan vezet egy cél egyeztetett állapotú befejezéshez — vagy biztonságos leálláshoz\? |
| Bizalom és korlátok | Mire nem következtethet a rendszer soha\, mit nem engedélyezhet\, és mit nem állíthat\? |
| Tanulás\, segítség és közreműködés | Hol található a részletes dokumentáció\, a támogatás\, a projektirányítás\, a fejlesztés és a licenc\? |

Ez a sorrend gyakorlati ívet ad\:

- **Kontextus\:** a promptok által vezérelt munka kifejezheti a szándékot anélkül\, hogy bizonyítaná a felhatalmazást vagy az állapotot\.
- **Feszültség\:** a mellékhatások ezt a hiányt szállítási kockázattá alakítják\.
- **Megoldás\:** a Better Workflows összekapcsolja a célt\, a hatókört\, a bizonyítékokat\, a felülvizsgálatot\, a műveletet és a szolgáltatói állapotegyeztetést\.
- **Bizonyítás\:** az egyértelmű garanciák és határok megmutatják\, hogyan működik a megoldás\.
- **Cselekvés\:** az olvasó még azelőtt eléri az első sikert\, hogy mélyreható megvalósítási részletekkel találkozna\.
- **Folytatás\:** a szerep\- és eredményalapú útvonalak a megfelelő oktatóanyaghoz\, gyakorlati útmutatóhoz\, magyarázathoz vagy referenciához vezetik az olvasót\.

## Válaszd el a nyitóoldal tartalmát a részletes dokumentációtól

A README a döntéshez fontos információkat tartalmazza\. A részletekhez a céljuk szerint irányíts\:

- [Első lépések](getting-started.md) az első használat oktatóanyaga\.
- [Munkafolyamatok](workflows.md) az eredmény kiválasztásának gyakorlati útmutatója\.
- [Architektúra](architecture.md) a vezérlési síkot és az alternatívák előnyeit\, illetve hátrányait magyarázza el\.
- [Biztonság](security-guide.md) a felhatalmazást\, a magánszférát\, a tanúsításokat és a sikeres ellenőrzés hiányában végrehajtást megtagadó működést magyarázza el\.
- [CLI\-referencia](cli-reference.md) a parancsreferencia\.
- A lokalizált `docs/details/*.md` oldalak megőrzik az átfogó\, lefordított részleteket\.

Ne ismételd meg a nyitóoldalon a gyorsítótár helyreállítását\, a zárolások birtoklását\, a szolgáltatói adatátvitel teljes szemantikáját\, a kimerítő parancslistákat vagy a megvalósítás módosítási előzményeit\. A tömör biztonsági állítás maradjon az adott oldalon\; az auditálható részletek a kanonikus útmutatóba tartoznak\.

Ez az elkülönítés a Diátaxis felosztását követi az oktatóanyagok\, gyakorlati útmutatók\, magyarázatok és referenciák között\. Egyetlen oldal nem tudja egyszerre optimálisan kiszolgálni mind a négy olvasói igényt\.

## Minden vizuális elemnek indokolnia kell a helyét

Csak akkor használj vizuális elemet\, ha a kapcsolatok\, a hierarchia vagy az állapotátmenetek így lényegesen könnyebben megérthetők\, mint folyószövegből\.

A nyitóoldalak két vizuális elemet engednek meg\:

1. **A felhatalmazási határok architektúrája\:** megmutatja\, mely rétegek alakítják a szándékot\, az aktuális tényeket\, az eszközök felhatalmazását\, a korlátozott újrapróbálkozásokat és a csak olvasható állapotot\.
2. **A céltól a befejezésig tartó életciklus\:** megmutatja\, hol ellenőrzik a bizonyítékokat\, hol engedélyezik a mellékhatásokat\, és hol állítja meg az ismeretlen állapot az előrehaladást\.

Minden vizuális elemhez kötelező\:

- tömör\, érdemi helyettesítő szöveg\;
- egy mellette elhelyezett szöveges megfelelő\, amely akkor is megőrzi a következtetést\, ha a vizuális elem rejtve van\, vagy a Mermaid nem jelenik meg\;
- tényleges szöveg a lényeges feliratokhoz\, amikor csak lehetséges\;
- egy tartósan érvényes olvasói kérdés\, amely indokolja a vizuális elem naprakészen tartását\.

Ne adj hozzá díszítő képernyőképeket\, szöveggel zsúfolt képeket vagy olyan diagramot\, amely csupán egy rövid listát ismétel meg\. A választást segítő táblázatokat korlátozd két tömör oszlopra\, hogy keskeny képernyőkön is használhatók maradjanak\.

## Őrizd meg a jelentést a nyelvek között

Az angol a szemantikai referencia\; nem az angol szöveg sorainak számát kell lemásolni\. A hagyományos kínai\, az egyszerűsített kínai\, a japán és a koreai szövegnek természetesnek kell hatnia az anyanyelvi olvasó számára\, miközben ugyanazt a szerződést őrzi meg\.

Az alábbi elemeknek egyenértékűnek kell maradniuk\:

- a nyolc szemantikai szakasz és azok sorrendje\;
- az első sikerhez vezető parancsok és a termékazonosítók\;
- a felhatalmazásra\, bizonyítékokra\, ismeretlen állapotra\, promptokra és magánszférára vonatkozó öt állítás\;
- a munkafolyamatok\, biztonság\, architektúra\, CLI\, támogatás\, projektirányítás\, fejlesztés és licenc hivatkozási céljai\;
- a vizuális elemek célja\, az életciklus szakaszai és a szöveges helyettesítések\;
- a verzió forrása és a jelvényekre vonatkozó szabályzat\.

A címsorok\, mondathatárok\, írásjelek\, példák és cselekvésre ösztönzések lehetnek nyelvileg természetesek\. Soha ne fordíts le parancsokat\, szelektorokat\, bizonyítékazonosítókat vagy biztonsági szemantikát\.

## Írj gyors áttekintéshez és fordításhoz

- Az olvasó eredményével kezdj\, és a fontos kifejezéseket helyezd a címsorok és bekezdések elejére\.
- Használj aktív szerkezeteket\, és nevezd meg a műveletért felelős szereplőt\.
- Az eljárásoknál közvetlenül az olvasót szólítsd meg\.
- Tartsd röviden a bekezdéseket\, és mindegyiknek egyetlen feladata legyen\.
- Sorrendhez számozott listát\, nem sorrendi választási lehetőségekhez felsorolást használj\.
- Általános „kattints ide” feliratok helyett leíró hivatkozásokat használj\.
- A címsorok legyenek hierarchikusak\, konkrétak és azonos szinten párhuzamos szerkezetűek\.
- Részesítsd előnyben a szó szerinti\, egyértelmű nyelvezetet\, amely fordításkor is megőrzi a jelentését\.
- A feltételeket az utasítások elé\, a várt eredményeket a parancsok után helyezd\.

## A szemantikát validáld\, ne a díszítést

A dokumentáció tesztjeinek a címsorok egyezésénél többet kell felismerniük\. Ezeket ellenőrzik\:

- egyetlen H1 és logikus címsor\-hierarchia\;
- rendezett szemantikai szakasz\- és kritikusállítás\-jelölők\;
- pontos\, elsőre sikeres parancsok és stabil azonosítók\;
- relatív hivatkozások és nyelvspecifikus részletcélok\;
- verziójelvény\-paritás a futásidejű metaadatokkal\;
- értelmes kép helyettesítő szövegek és szomszédos vizuális tartalékok\;
- egyetlen Mermaid életciklus teljes szöveges megfelelővel\;
- kétoszlopos táblázat\- és bekezdéshossz\-keretek\;
- kijelölt mély megvalósítási részletek hiánya a kezdőlapokról\;

## Kutatási alapok

- [GitHub\: A tároló README\-fájljáról](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) meghatározza a README első látogatáskori célját\, és javasolja a hosszú dokumentáció máshová helyezését\.
- [Diátaxis](https://diataxis.fr/start-here/) elkülöníti az oktatóanyag\, a gyakorlati útmutató\, a magyarázat és a referencia iránti igényeket\.
- [Microsoft\: Gyorsan áttekinthető tartalom](https://learn.microsoft.com/en-us/style-guide/scannable-content/) hangsúlyozza a legfontosabbat előre helyező szerkezetet\, a rövid bekezdéseket és a következetes vizuális belépési pontokat\.
- [A Google fejlesztői dokumentációjának stílusa](https://developers.google.com/style/highlights) aktív szerkezeteket\, közvetlen megszólítást\, leíró címsorokat\, akadálymentességet és globális közönségnek szóló írást javasol\.
- [GitHub\: Diagramok készítése](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) dokumentálja a Mermaid támogatását Markdown környezetben\.
- [W3C WAI\: Képek oktatóanyaga](https://www.w3.org/WAI/tutorials/images/) megköveteli a szöveges alternatívákat és az informatív\, illetve összetett vizuális elemek teljes megfelelőit\.
