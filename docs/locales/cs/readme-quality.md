<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Plán kvality README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · **Čeština** · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Přehled ve 41 lokalizovaných verzích a oficiální webové vstupní body](../../../docs/LANGUAGES.md)\. Anglická verze tohoto redakčního plánu zůstává kanonickým zdrojem\.

README projektu Better Workflows je vstupní stránka\, nikoli zhuštěná referenční příručka\. Jeho úkolem je pomoci čtenáři postupně zodpovědět pět otázek\:

1. Co to je a je to pro mě\?
2. Jaký problém to řeší\?
3. Proč bych měl jeho tvrzením důvěřovat\?
4. Jaká je nejkratší cesta k prvnímu úspěchu\?
5. Kam mám pokračovat dál\?

Tento plán stanovuje smlouvu pro vyprávění\, vizuální prvky\, lokalizaci a validaci každého README v repozitáři\. Strojově čitelným zdrojem je [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Začněte rozhodnutím čtenáře

GitHub zobrazuje README před většinou obsahu repozitáře\. První obrazovka proto musí vyjasnit příslib produktu\, zamýšlené publikum a další krok s vymezenými hranicemi\. Nesmí začínat interní architekturou\, úplnou referencí příkazů ani podrobnostmi obnovy vydání\.

Pište pro tyto úkoly čtenářů\:

- **Nový návštěvník\:** rychle se rozhodněte\, zda Better Workflows řeší relevantní problém\.
- **Nový uživatel\:** nainstalujte plugin a dosáhněte jedné úspěšné automatické trasy\.
- **Hodnotitel\:** pochopte hranici autority a fail\-closed chování\.
- **Vracející se operátor\:** přejděte k odpovědím ohledně workflow\, bezpečnosti\, architektury nebo CLI\.
- **Přispěvatel nebo překladatel\:** najděte kanonický kontrakt\, vývojové příkazy\, podporu a správu projektu\.

## Používejte vyprávění založené na příčinách a následcích

Pět vstupních README používá stejné osmidílné sémantické pořadí\. Nadpisy mohou být v každém jazyce idiomatické\, cesta čtenáře se však nemění\.

| Oddíl | Otázka čtenáře a role ve vyprávění |
| --- | --- |
| Příslib a publikum | Co je Better Workflows\, proč existuje a pro koho je určen\? |
| Od problému k výsledku | Co se pokazí\, když se zaměňují záměr\, pravomoc\, důkazy a výsledek u poskytovatele\? |
| Doložení a hranice | Které záruky činí navržený výsledek důvěryhodným\? |
| První úspěch | Jaká je nejkratší úplná cesta od instalace k výsledku\? |
| Výběr další cesty | Který pracovní postup nebo dokument odpovídá cíli čtenáře\? |
| Životní cyklus | Jak cíl vede k dokončení s ověřeným souladem stavů — nebo k bezpečnému zastavení\? |
| Důvěra a omezení | Co systém nikdy nemůže odvodit\, autorizovat nebo tvrdit\? |
| Učení\, pomoc a přispívání | Kde jsou podrobná dokumentace\, podpora\, správa projektu\, vývoj a licence\? |

Toto pořadí vytváří praktickou návaznost příběhu\:

- **Kontext\:** práce řízená prompty může vyjádřit záměr\, aniž by prokázala pravomoc nebo stav\.
- **Napětí\:** vedlejší účinky mění tuto mezeru v riziko pro dodání výsledku\.
- **Řešení\:** Better Workflows propojuje cíl\, rozsah\, důkazy\, revizi\, akci a kontrolu souladu stavu s poskytovatelem\.
- **Doložení\:** výslovné záruky a hranice ukazují\, jak řešení funguje\.
- **Akce\:** čtenář dosáhne prvního úspěchu dříve\, než se setká s podrobnými informacemi o implementaci\.
- **Pokračování\:** cesty podle role a výsledku vedou čtenáře ke správnému výukovému průvodci\, praktickému návodu\, vysvětlení nebo referenci\.

## Oddělte vstupní obsah od podrobné dokumentace

Používejte README pro informace důležité pro rozhodnutí\. Na podrobnosti odkazujte podle jejich účelu\:

- [Začínáme](getting-started.md) je výukový průvodce prvním použitím\.
- [Pracovní postupy](workflows.md) jsou praktickým návodem k výběru výsledku\.
- [Architektura](architecture.md) vysvětluje řídicí rovinu a výhody i nevýhody jednotlivých možností\.
- [Bezpečnost](security-guide.md) vysvětluje pravomoci\, soukromí\, atestace a chování\, které bez úspěšného ověření blokuje provedení\.
- [Reference CLI](cli-reference.md) je referencí příkazů\.
- Lokalizované stránky `docs/details/*.md` zachovávají úplné přeložené podrobnosti\.

Neduplikujte na vstupní stránce obnovu mezipaměti\, vlastnictví zámků\, úplnou sémantiku transportní komunikace s poskytovateli\, vyčerpávající seznamy příkazů ani historii změn implementace\. Stručné bezpečnostní tvrzení zůstává na samotné stránce\; jeho auditovatelné podrobnosti patří do kanonického průvodce\.

Toto oddělení vychází z rozlišení Diátaxis mezi výukovými průvodci\, praktickými návody\, vysvětlením a referencí\. Jedna stránka nemůže současně optimálně naplnit všechny čtyři potřeby čtenáře\.

## Každý vizuální prvek si musí své místo zasloužit

Používejte vizuální prvek jen tehdy\, když jsou díky němu vztahy\, hierarchie nebo přechody stavů podstatně snazší k pochopení než z běžného textu\.

Vstupní stránky dovolují dva vizuální prvky\:

1. **Architektura hranic pravomocí\:** odpovídá na to\, které vrstvy utvářejí záměr\, aktuální fakta\, pravomoci nástrojů\, omezené opakované pokusy a stav pouze pro čtení\.
2. **Životní cyklus od cíle k dokončení\:** odpovídá na to\, kde se kontrolují důkazy\, kde se autorizují vedlejší účinky a kde neznámý stav zastavuje postup\.

Každý vizuální prvek musí obsahovat\:

- stručný a smysluplný alternativní text\;
- přilehlý textový ekvivalent\, který zachová závěr\, když je vizuální prvek skrytý nebo se Mermaid nevykreslí\;
- skutečný text pro zásadní popisky\, kdykoli je to možné\;
- trvale relevantní otázku čtenáře\, která odůvodňuje udržování vizuálního prvku v aktuálním stavu\.

Nepřidávejte dekorativní snímky obrazovky\, obrázky přeplněné textem ani diagram\, který pouze duplikuje krátký seznam\. Výběrové tabulky omezte na dva stručné sloupce\, aby zůstaly použitelné na úzkých obrazovkách\.

## Zachovávejte význam napříč jazyky

Angličtina je sémantickou referencí\, nikoli cílem pro počet řádků\. Tradiční čínština\, zjednodušená čínština\, japonština a korejština mají rodilému čtenáři znít přirozeně a přitom zachovávat stejnou smlouvu\.

Následující položky musí zůstat rovnocenné\:

- osm sémantických oddílů a jejich pořadí\;
- příkazy pro první úspěch a identifikátory produktu\;
- pět tvrzení o pravomocích\, důkazech\, neznámém stavu\, promptech a soukromí\;
- cíle odkazů na pracovní postupy\, bezpečnost\, architekturu\, CLI\, podporu\, správu projektu\, vývoj a licenci\;
- účel vizuálních prvků\, fáze životního cyklu a textové alternativy\;
- zdroj verze a pravidla pro odznaky\.

Nadpisy\, hranice vět\, interpunkce\, příklady a výzvy k akci mohou být idiomatické\. Nikdy nepřekládejte příkazy\, selektory\, identifikátory důkazů ani bezpečnostní sémantiku\.

## Pište pro rychlé procházení a překlad

- Začínejte výsledkem pro čtenáře a důležité pojmy umisťujte na začátek nadpisů a odstavců\.
- Používejte činný rod a pojmenujte aktéra odpovědného za akci\.
- V postupech oslovujte čtenáře přímo\.
- Udržujte odstavce krátké a každému přidělte jediný úkol\.
- Pro pořadí používejte číslované seznamy\, pro volby bez daného pořadí odrážky\.
- Používejte popisné odkazy namísto obecných popisků typu „klikněte sem“\.
- Udržujte nadpisy hierarchické\, konkrétní a na stejné úrovni stejně vystavěné\.
- Upřednostňujte doslovný\, jednoznačný jazyk\, který si zachová význam při překladu\.
- Podmínky uvádějte před pokyny a očekávané výsledky za příkazy\.

## Validujte sémantiku\, ne dekoraci

Testy dokumentace musí zjišťovat více než shodu nadpisů\. Ověřují\:

- jeden nadpis H1 a logická hierarchie nadpisů\;
- uspořádané značky sémantických sekcí a kritických tvrzení\;
- přesné příkazy pro první úspěch a stabilní identifikátory\;
- relativní odkazy a cíle podrobností specifické pro dané národní prostředí\;
- shoda odznaku verze s metadaty běhového prostředí\;
- smysluplný alternativní text obrázků a přilehlé vizuální záložní varianty\;
- jediný životní cyklus v Mermaid s úplným textovým ekvivalentem\;
- rozpočty pro dvousloupcové tabulky a délku odstavců\;
- absence určených hlubokých implementačních detailů na vstupních stránkách\;

## Výzkumné podklady

- [GitHub\: O souboru README repozitáře](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) definuje účel README při první návštěvě a doporučuje přesunout rozsáhlou dokumentaci jinam\.
- [Diátaxis](https://diataxis.fr/start-here/) odděluje potřeby výukového průvodce\, praktického návodu\, vysvětlení a reference\.
- [Microsoft\: Snadno procházetelný obsah](https://learn.microsoft.com/en-us/style-guide/scannable-content/) zdůrazňuje strukturu s nejdůležitějšími informacemi na začátku\, krátké odstavce a jednotné vizuální vstupní body\.
- [Styl vývojářské dokumentace Google](https://developers.google.com/style/highlights) doporučuje činný rod\, přímé oslovení\, popisné nadpisy\, přístupnost a psaní pro celosvětové publikum\.
- [GitHub\: Vytváření diagramů](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) dokumentuje podporu Mermaid v Markdown\.
- [W3C WAI\: Výukový průvodce obrázky](https://www.w3.org/WAI/tutorials/images/) vyžaduje textové alternativy a úplné ekvivalenty informativních a složitých vizuálních prvků\.
