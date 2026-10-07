<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Rámec kvality README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · **Slovenčina** · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Prehľad v 41 lokalizovaných vydaniach a oficiálne webové vstupné body](../../../docs/LANGUAGES.md)\. Kanonickým zdrojom tohto redakčného rámca zostáva anglické znenie\.

README projektu Better Workflows je vstupná stránka\, nie zhustená referenčná príručka\. Jeho úlohou je pomôcť čitateľovi postupne odpovedať na päť otázok\:

1. Čo je to a je to pre mňa\?
2. Aký problém to rieši\?
3. Prečo by som mal dôverovať jeho tvrdeniam\?
4. Aká je najkratšia cesta k prvému úspechu\?
5. Kam mám pokračovať\?

Tento rámec definuje kontrakt pre naratív\, vizuálny obsah\, lokalizáciu a validáciu každého README v repozitári\. Strojovo čitateľným zdrojom je [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Začnite rozhodnutím čitateľa

GitHub zobrazuje README pred väčšinou obsahu repozitára\. Prvá obrazovka preto musí objasniť prísľub produktu\, cieľovú skupinu a ďalší krok s jasnými hranicami\. Nesmie sa začínať internou architektúrou\, úplnou referenčnou príručkou príkazov ani podrobnosťami o obnove vydaní\.

Píšte pre tieto potreby čitateľov\:

- **Nový návštevník\:** rýchlo zistite\, či Better Workflows rieši relevantný problém\.
- **Nový používateľ\:** nainštalujte si plugin a prejdite jednu úspešnú automatickú trasu\.
- **Hodnotiteľ\:** pochopte hranicu autority a správanie fail\-closed\.
- **Vracajúci sa operátor\:** prejdite priamo na odpoveď o workflowoch\, bezpečnosti\, architektúre alebo CLI\.
- **Prispievateľ alebo prekladateľ\:** nájdite kánonický kontrakt\, vývojové príkazy\, podporu a správu projektu\.

## Použite naratív príčiny a následku

Päť vstupných súborov README používa rovnakú osemdielnu sémantickú postupnosť\. Nadpisy môžu byť v každom jazyku prirodzené\, ale cesta čitateľa sa nemení\.

| Sekcia | Otázka čitateľa a úloha v naratíve |
| --- | --- |
| Prísľub a cieľová skupina | Čo je Better Workflows\, prečo existuje a pre koho je určený\? |
| Od problému k výsledku | Čo sa pokazí\, keď sa zamieňajú zámer\, právomoci\, dôkazy a výsledok poskytovateľa\? |
| Doloženie a hranice | Ktoré záruky robia navrhovaný výsledok dôveryhodným\? |
| Prvý úspech | Aká je najkratšia úplná cesta od inštalácie k výsledku\? |
| Výber ďalšej cesty | Ktorý pracovný postup alebo dokument zodpovedá cieľu čitateľa\? |
| Životný cyklus | Ako sa cieľ zmení na dokončenie s overeným súladom výsledkov — alebo sa bezpečne zastaví\? |
| Dôvera a obmedzenia | Čo systém nikdy nesmie odvodiť\, autorizovať ani tvrdiť\? |
| Učiť sa\, získať pomoc\, prispievať | Kde je podrobná dokumentácia\, podpora\, správa projektu\, vývoj a licencia\? |

Toto poradie vytvára praktický dejový oblúk\:

- **Kontext\:** práca riadená pokynmi pre modely môže vyjadriť zámer bez preukázania právomocí alebo stavu\.
- **Napätie\:** vedľajšie účinky menia túto medzeru na riziko pri dodaní výsledku\.
- **Riešenie\:** Better Workflows prepája cieľ\, rozsah\, dôkazy\, revíziu\, činnosť a overenie súladu s výsledkom poskytovateľa\.
- **Doloženie\:** výslovné záruky a hranice ukazujú\, ako riešenie funguje\.
- **Činnosť\:** čitateľ dosiahne prvý úspech skôr\, než sa stretne s podrobnými implementačnými detailmi\.
- **Pokračovanie\:** cesty podľa roly a výsledku vedú čitateľa k správnemu tutoriálu\, praktickému návodu\, vysvetleniu alebo referenčnej príručke\.

## Oddeľte vstupný obsah od podrobnej dokumentácie

README používajte na informácie relevantné pre rozhodnutie\. Na podrobnosti odkazujte podľa účelu\:

- [Začíname](getting-started.md) je tutoriál pre prvé použitie\.
- [Pracovné postupy](workflows.md) sú praktickým návodom na výber výsledku\.
- [Architektúra](architecture.md) vysvetľuje riadiacu rovinu a kompromisy\.
- [Bezpečnosť](security-guide.md) vysvetľuje právomoci\, súkromie\, atestácie a správanie\, ktoré pri chýbajúcom overení blokuje činnosť\.
- [Referenčná príručka CLI](cli-reference.md) je referenčnou príručkou príkazov\.
- Lokalizované stránky `docs/details/*.md` zachovávajú úplné preložené podrobnosti\.

Na vstupnej stránke neduplikujte obnovu vyrovnávacej pamäte\, vlastníctvo zámkov\, úplnú sémantiku prenosu k poskytovateľom\, vyčerpávajúci prehľad príkazov ani históriu implementačných zmien\. Stručné bezpečnostné tvrdenie zostáva na stránke\; jeho auditovateľné podrobnosti patria do kanonickej príručky\.

Toto oddelenie vychádza z rozlíšenia Diátaxis medzi tutoriálmi\, praktickými návodmi\, vysvetleniami a referenčnými príručkami\. Jednu stránku nemožno optimalizovať pre všetky štyri potreby čitateľov naraz\.

## Každý vizuálny prvok musí mať opodstatnenie

Vizuálny prvok použite len vtedy\, keď výrazne uľahčuje pochopenie vzťahov\, hierarchie alebo prechodov medzi stavmi oproti súvislému textu\.

Na vstupných stránkach sú povolené dva vizuálne prvky\:

1. **Architektúra hraníc právomocí\:** odpovedá\, ktoré vrstvy formujú zámer\, aktuálne fakty\, oprávnenia nástrojov\, obmedzené opakované pokusy a stav iba na čítanie\.
2. **Životný cyklus od cieľa po dokončenie\:** odpovedá\, kde sa kontrolujú dôkazy\, kde sa autorizujú vedľajšie účinky a kde neznámy stav zastavuje postup\.

Každý vizuálny prvok musí obsahovať\:

- stručný a zmysluplný alternatívny text\;
- susediaci textový ekvivalent\, ktorý zachová záver\, keď je vizuálny prvok skrytý alebo sa Mermaid nevykreslí\;
- skutočný text pre podstatné označenia\, kedykoľvek je to možné\;
- stabilnú otázku čitateľa\, ktorá odôvodňuje udržiavanie vizuálneho prvku v aktuálnom stave\.

Nepridávajte ozdobné snímky obrazovky\, obrázky preplnené textom ani diagram\, ktorý iba duplikuje krátky zoznam\. Výberové tabuľky obmedzte na dva stručné stĺpce\, aby zostali použiteľné na úzkych obrazovkách\.

## Zachovajte význam medzi jazykmi

Angličtina je sémantickou referenciou\, nie cieľovým počtom riadkov\. Tradičná čínština\, zjednodušená čínština\, japončina a kórejčina majú znieť prirodzene rodenému čitateľovi a zároveň zachovávať rovnaký kontrakt\.

Nasledujúce položky musia zostať ekvivalentné\:

- osem sémantických sekcií a ich poradie\;
- príkazy vedúce k prvému úspechu a identifikátory produktov\;
- päť tvrdení o právomociach\, dôkazoch\, neznámom stave\, pokynoch pre modely a súkromí\;
- cieľové odkazy na pracovné postupy\, bezpečnosť\, architektúru\, CLI\, podporu\, správu projektu\, vývoj a licenciu\;
- účel vizuálnych prvkov\, etapy životného cyklu a náhradné texty\;
- zdroj verzie a pravidlá pre odznaky\.

Nadpisy\, hranice viet\, interpunkcia\, príklady a výzvy na činnosť môžu byť prirodzené pre daný jazyk\. Nikdy neprekladajte príkazy\, selektory\, identifikátory dôkazov ani bezpečnostnú sémantiku\.

## Píšte na rýchle prezeranie a preklad

- Začnite výsledkom pre čitateľa a dôležité pojmy umiestnite na začiatok nadpisov a odsekov\.
- Používajte činný rod a pomenujte aktéra zodpovedného za činnosť\.
- Pri postupoch oslovujte čitateľa priamo\.
- Odseky udržujte krátke a každému dajte jedinú úlohu\.
- Na postupnosť používajte číslované zoznamy a na možnosti bez poradia odrážky\.
- Používajte opisné odkazy namiesto všeobecných označení ako „kliknite sem“\.
- Nadpisy udržujte hierarchické\, konkrétne a na rovnakej úrovni súbežne formulované\.
- Uprednostňujte doslovný\, jednoznačný jazyk\, ktorý si zachová význam pri preklade\.
- Podmienky uvádzajte pred pokynmi a očakávané výsledky po príkazoch\.

## Overujte sémantiku\, nie ozdoby

Testy dokumentácie musia zisťovať viac než zhodu nadpisov\. Overujú\:

- jeden nadpis H1 a logická hierarchia nadpisov\;
- usporiadané sémantické sekcie a značky kritických tvrdení\;
- presné príkazy na prvý úspech a stabilné identifikátory\;
- relatívne odkazy a cieľové stránky podrobností špecifické pre danú lokalizáciu\;
- parita odznakov verzií s metadátami runtime\;
- zmysluplný alternatívny text obrázkov a susediace vizuálne náhrady\;
- jeden životný cyklus Mermaid s úplným textovým ekvivalentom\;
- limity pre dvojstĺpcové tabuľky a dĺžku odsekov\;
- absencia vyhradených hĺbkových implementačných detailov na vstupných stránkach\;

## Výskumné východiská

- [GitHub\: O súbore README repozitára](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) definuje účel README pri prvej návšteve a odporúča presunúť rozsiahlu dokumentáciu inam\.
- [Diátaxis](https://diataxis.fr/start-here/) oddeľuje potreby tutoriálov\, praktických návodov\, vysvetlení a referenčných príručiek\.
- [Microsoft\: Obsah na rýchle prezeranie](https://learn.microsoft.com/en-us/style-guide/scannable-content/) zdôrazňuje štruktúru s najdôležitejšími vecami na začiatku\, krátke odseky a konzistentné vizuálne vstupné body\.
- [Štýl vývojárskej dokumentácie Google](https://developers.google.com/style/highlights) odporúča činný rod\, priame oslovenie\, opisné nadpisy\, prístupnosť a písanie pre celosvetové publikum\.
- [GitHub\: Vytváranie diagramov](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) dokumentuje podporu Mermaid v Markdown\.
- [W3C WAI\: Tutoriál o obrázkoch](https://www.w3.org/WAI/tutorials/images/) vyžaduje textové alternatívy a úplné ekvivalenty informatívnych a zložitých vizuálnych prvkov\.
